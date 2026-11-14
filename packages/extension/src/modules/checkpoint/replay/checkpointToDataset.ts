/**
 * A checkpoint made a Frozen dataset in memory, for the Frozen loader to set
 * its records up again in another org: what a replay loads.
 *
 * Nothing goes to disk and nothing is pseudonymized unless asked. Three steps,
 * the checkpoint's own org never asked:
 *
 * 1. {@link surveyCheckpoint} reads the checkpoint's snapshot once for what
 *    its records name: their ids, the users, queues, record types and
 *    profiles they point at, the currencies, the prices.
 * 2. {@link readReplayTarget} reads the other org for what the survey asks
 *    of it: the describes of the objects replayed, its users at the ids the
 *    records name or under the same username, its record types, queues,
 *    currencies and standard price book, and whether it holds records of the
 *    checkpoint under the same Ids — a sandbox copied from the same
 *    production does.
 * 3. {@link checkpointToDataset} reads the snapshot again and converts each
 *    record:
 *    - its key is `<Object>-<its Id, 18 characters>`, the same from one
 *      replay, and one machine, to the next;
 *    - a lookup to a record it replays names that record's key; one to a
 *      record the other org holds under the same Id keeps the Id, and that
 *      record is linked — neither created, changed nor removed; one to
 *      anything else is emptied and counted, or, required, refuses the row
 *      before anything is written, and so every record that points at it: no
 *      orphan is ever written;
 *    - a text that holds an Id stays as it is: only a field the other org
 *      describes as a lookup is read as one;
 *    - an owner stays when the other org holds the same active standard user,
 *      by Id or, with the annex, by username once a sandbox's suffix is taken
 *      off; else the record goes to the user who replays, counted with why;
 *    - a record type is found by its developer name and namespace (annex), by
 *      its Id, or left to the other org's default, each counted by object;
 *    - person accounts go with their contacts, which the platform writes
 *      itself; a currency the other org has not activated refuses its rows;
 *      a single-currency org takes the amounts as they are, in its currency;
 *    - email addresses and phone numbers are made unreachable unless kept,
 *      then personal data masked when asked.
 *
 * What does not go across as it was is said in the summary
 * (`CheckpointReplaySummary`): a success hides nothing.
 */

import {
  PRICEBOOK_ENTRY_BOOK_FIELD,
  PRICEBOOK_ENTRY_CURRENCY_FIELD,
  PRICEBOOK_ENTRY_OBJECT,
  PRICEBOOK_ENTRY_PRODUCT_FIELD,
  STANDARD_PRICEBOOK_SOQL,
  isPlatformRequiredField,
  type CheckpointReplayAnnex,
  type CheckpointReplayAnnexPart,
  type CheckpointReplayChoices,
  type CheckpointReplayLookupEmptiedReason,
  type CheckpointReplayNotReplayedReason,
  type CheckpointReplayRefusedReason,
  type CheckpointReplaySummary,
  type OrgCheckpoint,
} from '@sandforge/shared';
import {
  accountKindOf,
  isPersonAccountRow,
  leftOutForAccountKind,
} from '../../../core/common/platformRecords.js';
import { canonicalRecordId } from '../../../core/common/existingRecordMatch.js';
import { extractErrorMessage } from '../../../core/common/extractErrorMessage.js';
import { assertSoqlIdentifier, sanitizeSoqlValue } from '../../../core/common/soqlValidator.js';
import { qualifiedRecordTypeName } from '../../../core/metadata/recordTypeNames.js';
import { PIIDetector, personalFieldsByApiName } from '../../../core/precheck/PIIDetector.js';
import type { FieldInfo } from '../../forge/ForgeExecutor.js';
import { ForgeAnonymizer, type PIIFieldInfo } from '../../forge/ForgeAnonymizer.js';
import { ContactPointNeutralizer } from '../../forge/stages/ContactPointNeutralizer.js';
import type {
  TargetFieldDescribe,
  TargetObjectDescribe,
  TargetOrgAccess,
} from '../../frozendataset/loadTypes.js';
import type {
  FrozenDataset,
  FrozenRecord,
  FrozenRecordTypeRef,
  PersonContactLink,
} from '../../frozendataset/types.js';
import type { CheckpointFolder } from '../OrgCheckpointStore.js';
import { PERSON_ACCOUNT_FLAG, SNAPSHOT_STAMPS } from '../checkpointFields.js';
import { heldFileLinks } from '../checkpointFiles.js';
import { FILE_LINK_OBJECT } from '../checkpointScope.js';
import { SnapshotIndex } from '../snapshotIndex.js';
import {
  holdsFileContent,
  replayableObjectsOf,
  type ReplayableObjects,
} from './replaySourceGuard.js';

// ─── Ids ─────────────────────────────────────────────────────────────────────

/** A record's key, as the org compares ids: its first fifteen characters. */
function keyOf(id: string): string {
  return id.slice(0, 15);
}

/** Whether a value is shaped as a record's id. */
const ID_SHAPE = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** An id's 18-character form, or the value as given when it is none. */
function eighteen(id: string): string {
  return canonicalRecordId(id) ?? id;
}

/**
 * The key a replay sets a record of the checkpoint up under, and finds it by
 * again: its object and its Id there, 18 characters. The same whichever
 * machine replays it, and whichever replay of it.
 */
export function replayReferenceIdOf(objectApiName: string, id: string): string {
  return `${objectApiName}-${eighteen(id)}`;
}

/** The key prefixes a lookup's value is told by, before the object it points at. */
const USER_PREFIX = '005';
const QUEUE_PREFIX = '00G';
const ORG_PREFIX = '00D';
const PROFILE_PREFIX = '00e';

/** A record's owner. */
const OWNER_FIELD = 'OwnerId';
const RECORD_TYPE_FIELD = 'RecordTypeId';
/** A hierarchy custom setting's row's owner: the org, a profile or a user. */
const SETUP_OWNER_FIELD = 'SetupOwnerId';
const CURRENCY_FIELD = 'CurrencyIsoCode';
const PRICEBOOK_OBJECT = 'Pricebook2';

/** Statements' ids, as many as a statement holds: the length the take's reads of files by their ids hold to. */
const IDS_PER_READ = 200;

/** The fields of a record a replay never sends: its Id, and the stamps the platform writes itself. */
const NEVER_SENT: ReadonlySet<string> = new Set([...SNAPSHOT_STAMPS, PERSON_ACCOUNT_FLAG]);

// ─── 1. The survey ───────────────────────────────────────────────────────────

/** A price of the checkpoint, as the standard price book is told by when no annex names it. */
interface SurveyedPrice {
  book: string;
  product: string;
  currency: string;
}

/** What the checkpoint's records name, read once before the other org is asked. */
export interface ReplaySurvey {
  objects: ReplayableObjects;
  /** Every record the checkpoint holds, of every object, by key, with its object. */
  heldBy: ReadonlyMap<string, string>;
  /** Users the records name, by key: owners and any other lookup to a user. */
  users: ReadonlySet<string>;
  /** Queues that own records, by key. */
  queues: ReadonlySet<string>;
  /** Record types the records have, by key. */
  recordTypes: ReadonlySet<string>;
  /** Profiles a hierarchy custom setting's rows belong to, by key. */
  profiles: ReadonlySet<string>;
  /**
   * Per `Object.Field`, the ids its values name of records the checkpoint
   * does not hold — perhaps a lookup, which the other org's describe tells —
   * by key.
   */
  notHeld: ReadonlyMap<string, ReadonlySet<string>>;
  /** Currencies the records are in. */
  currencies: ReadonlySet<string>;
  /** The price book the checkpoint's standard prices are in, and how it was told. */
  standardPricebook: {
    id?: string;
    how: NonNullable<CheckpointReplaySummary['standardPricebook']>;
  };
  /** The links of the files to the records replayed, as the checkpoint holds them. */
  fileLinks: ReadonlyArray<{
    ContentDocumentId: string;
    LinkedEntityId: string;
    ShareType: string;
    Visibility: string;
  }>;
  /** Each file the replay leaves, a checkpoint keeping no file's content: see {@link ReplayFileLeft}. */
  filesLeft: readonly ReplayFileLeft[];
}

/**
 * A file the replay leaves where it was, named: a checkpoint keeps no file's
 * content, and a person told "2 files" alone would not know which to bring
 * over by hand.
 */
export interface ReplayFileLeft {
  objectApiName: string;
  id: string;
  /** Its title, or its name, as the checkpoint holds it; absent when it holds neither. */
  name?: string;
}

/** The field a file's records are named by, object by object. */
const FILE_NAME_FIELDS: readonly string[] = ['Title', 'Name'];

/** What a survey and a conversion read the checkpoint with. */
export interface ReplaySource {
  folder: CheckpointFolder;
  checkpoint: OrgCheckpoint;
  /** Its annex (`readReplayAnnex`): undefined for one taken before 1.81. */
  annex: CheckpointReplayAnnex | undefined;
  choices: CheckpointReplayChoices;
}

/** The records of an object of the checkpoint, one at a time, as it holds them now. */
async function* recordsOf(
  source: Pick<ReplaySource, 'folder' | 'checkpoint'>,
  objectApiName: string,
): AsyncGenerator<Record<string, unknown> & { Id: string }> {
  const index = await SnapshotIndex.read(
    source.folder,
    source.checkpoint.snapshotId,
    objectApiName,
  );
  for await (const record of index.records()) {
    if (typeof record.Id === 'string') yield record as Record<string, unknown> & { Id: string };
  }
}

/** The ids of an object's records, read from its index alone. */
async function idsOf(
  source: Pick<ReplaySource, 'folder' | 'checkpoint'>,
  objectApiName: string,
): Promise<string[]> {
  const index = await SnapshotIndex.read(
    source.folder,
    source.checkpoint.snapshotId,
    objectApiName,
  );
  const ids: string[] = [];
  for (let row = 0; row < index.size; row++) ids.push(index.idAt(row));
  return ids;
}

/** Whether the annex can be read for a part: the take read it, and the org answered it. */
function annexHas(
  annex: CheckpointReplayAnnex | undefined,
  part: CheckpointReplayAnnexPart,
): annex is CheckpointReplayAnnex {
  return annex !== undefined && !annex.unread.some((each) => each.part === part);
}

/**
 * Read what the checkpoint's records name: once, from its files, the
 * checkpoint's org never asked.
 */
export async function surveyCheckpoint(source: ReplaySource): Promise<ReplaySurvey> {
  const objects = replayableObjectsOf(source.checkpoint, source.choices);
  const heldBy = new Map<string, string>();
  for (const object of source.checkpoint.objects) {
    for (const id of await idsOf(source, object.objectApiName)) {
      heldBy.set(keyOf(id), object.objectApiName);
    }
  }
  const users = new Set<string>();
  const queues = new Set<string>();
  const recordTypes = new Set<string>();
  const profiles = new Set<string>();
  const notHeld = new Map<string, Set<string>>();
  const currencies = new Set<string>();
  const prices: SurveyedPrice[] = [];
  const replayedKeys = new Set<string>();
  for (const object of objects.replayed) {
    for await (const record of recordsOf(source, object.objectApiName)) {
      replayedKeys.add(keyOf(record.Id));
      for (const [field, value] of Object.entries(record)) {
        if (NEVER_SENT.has(field) || typeof value !== 'string') continue;
        if (field === CURRENCY_FIELD && value !== '') currencies.add(value);
        if (!ID_SHAPE.test(value)) continue;
        const key = keyOf(value);
        if (field === RECORD_TYPE_FIELD) recordTypes.add(key);
        else if (key.startsWith(USER_PREFIX)) users.add(key);
        else if (key.startsWith(QUEUE_PREFIX) && field === OWNER_FIELD) queues.add(key);
        else if (key.startsWith(PROFILE_PREFIX) && field === SETUP_OWNER_FIELD) profiles.add(key);
        else if (!heldBy.has(key) && !key.startsWith(ORG_PREFIX)) {
          const at = `${object.objectApiName}.${field}`;
          const seen = notHeld.get(at) ?? new Set<string>();
          seen.add(key);
          notHeld.set(at, seen);
        }
      }
      if (object.objectApiName === PRICEBOOK_ENTRY_OBJECT) {
        const book = record[PRICEBOOK_ENTRY_BOOK_FIELD];
        const product = record[PRICEBOOK_ENTRY_PRODUCT_FIELD];
        if (typeof book === 'string' && typeof product === 'string') {
          const currency = record[PRICEBOOK_ENTRY_CURRENCY_FIELD];
          prices.push({
            book: keyOf(book),
            product: keyOf(product),
            currency: typeof currency === 'string' ? currency : '',
          });
        }
      }
    }
  }
  const fileLinks: Array<ReplaySurvey['fileLinks'][number]> = [];
  if ((source.checkpoint.files?.links ?? 0) > 0) {
    for await (const link of heldFileLinks(source.folder)) {
      if (replayedKeys.has(keyOf(link.LinkedEntityId))) {
        fileLinks.push({
          ContentDocumentId: link.ContentDocumentId,
          LinkedEntityId: link.LinkedEntityId,
          ShareType: link.ShareType,
          Visibility: link.Visibility,
        });
      }
    }
  }
  const filesLeft: ReplayFileLeft[] = [];
  for (const left of objects.leftOut) {
    if (left.reason !== 'fileContentNotKept') continue;
    for await (const record of recordsOf(source, left.objectApiName)) {
      const name = FILE_NAME_FIELDS.map((field) => record[field]).find(
        (value): value is string => typeof value === 'string' && value !== '',
      );
      filesLeft.push({
        objectApiName: left.objectApiName,
        id: eighteen(record.Id),
        ...(name !== undefined ? { name } : {}),
      });
    }
  }
  return {
    objects,
    heldBy,
    users,
    queues,
    recordTypes,
    profiles,
    notHeld,
    currencies,
    standardPricebook: standardPricebookOf(source, prices),
    fileLinks,
    filesLeft,
  };
}

/**
 * The price book the checkpoint's standard prices are in: the annex's, else
 * the one book that prices every product, in every currency, that any book
 * prices — a custom price needs a standard one first
 * (`STANDARD_PRICE_NOT_DEFINED`), so the standard book is among those that
 * do. None or several such books tell nothing, and the prices are refused.
 */
function standardPricebookOf(
  source: ReplaySource,
  prices: readonly SurveyedPrice[],
): ReplaySurvey['standardPricebook'] {
  const catalog = source.checkpoint.objects.some(
    (object) =>
      object.objectApiName === PRICEBOOK_OBJECT || object.objectApiName === PRICEBOOK_ENTRY_OBJECT,
  );
  if (annexHas(source.annex, 'standardPricebook') && source.annex.standardPricebookId) {
    return { id: eighteen(source.annex.standardPricebookId), how: 'annex' };
  }
  if (prices.length === 0 || !catalog) return { how: 'none' };
  const pairs = new Set(prices.map((price) => `${price.product}|${price.currency}`));
  const byBook = new Map<string, Set<string>>();
  for (const price of prices) {
    const priced = byBook.get(price.book) ?? new Set<string>();
    priced.add(`${price.product}|${price.currency}`);
    byBook.set(price.book, priced);
  }
  const whole = [...byBook]
    .filter(([, priced]) => priced.size === pairs.size)
    .map(([book]) => book);
  return whole.length === 1 ? { id: eighteen(whole[0]), how: 'deduced' } : { how: 'ambiguous' };
}

// ─── 2. The other org ────────────────────────────────────────────────────────

/** A user of the other org a replay may give records to. */
export interface ReplayTargetUser {
  id: string;
  username: string;
  isActive: boolean;
  userType: string;
}

/** A record type of the other org. */
export interface ReplayTargetRecordType {
  id: string;
  sobjectType: string;
  developerName: string;
  namespacePrefix?: string;
  name: string;
  isActive: boolean;
  isPersonType?: boolean;
}

/** What a replay read of the other org, before it converts a record. */
export interface ReplayTarget {
  /** Its Organization Id, 18 characters: what a hierarchy setting's org-wide row is given. */
  organizationId: string;
  /** The user the replay writes as. */
  runningUserId: string;
  /** The describes of the objects replayed it has. */
  describes: ReadonlyMap<string, TargetObjectDescribe>;
  /** The objects replayed it has not, with the words it refused their describe with. */
  missing: ReadonlyMap<string, string>;
  /** Its users at the ids the records name and under the usernames the annex keeps, by key. */
  usersById: ReadonlyMap<string, ReplayTargetUser>;
  /** By the key of a user of the checkpoint, the user of the other org under the same username. */
  usersByUsername: ReadonlyMap<string, ReplayTargetUser>;
  recordTypes: readonly ReplayTargetRecordType[];
  queues: ReadonlyArray<{ id: string; developerName: string; sobjectTypes: readonly string[] }>;
  /** Its active currencies; undefined for an org of one currency, whose objects have no currency field. */
  currencies?: ReadonlySet<string>;
  /** Its standard price book, when asked. */
  standardPricebookId?: string;
  /** The records it holds under the Ids the checkpoint names them by, by key. */
  sameIds: ReadonlySet<string>;
  /** Of each custom setting replayed, the names and owners of the rows it holds. */
  customSettings: ReadonlyMap<string, { names: ReadonlySet<string>; owners: ReadonlySet<string> }>;
  /** The profiles it holds of those a setting's rows belong to, by key. */
  profiles: ReadonlySet<string>;
  /** The files it holds of those linked to a record replayed, by key. */
  files: ReadonlySet<string>;
  /** The requests the reads sent: what the replay's API budget counts. */
  requests: number;
}

/** What the other org is read with. */
export interface ReplayTargetRead {
  access: Pick<TargetOrgAccess, 'query' | 'describe'>;
  /** The org as the access names it. */
  orgId: string;
  /** Its Organization Id, as it answered once connected. */
  organizationId: string;
  /** The user the replay writes to it as. */
  runningUserId: string;
  /**
   * Its kind: a sandbox's usernames end with the sandbox's name, which the
   * one the replay connects as gives.
   */
  tier: 'sandbox' | 'scratch' | 'developer';
  /** The username the replay connects as. */
  username?: string;
  source: ReplaySource;
  survey: ReplaySurvey;
}

/** `items`, `size` at a time. */
function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
}

/** Ids as a SOQL list. */
function idList(keys: readonly string[]): string {
  return keys.map((key) => `'${sanitizeSoqlValue(key)}'`).join(', ');
}

/** A username without a sandbox's name after its domain: `ada@example.com.uat` → `ada@example.com`. */
function withoutSandboxSuffix(username: string): string {
  const at = username.lastIndexOf('@');
  const dot = username.lastIndexOf('.');
  const domain = username.slice(at + 1);
  // A domain of one dot (`example.com`) has no suffix to take off.
  return at >= 0 && dot > at && domain.split('.').length > 2 ? username.slice(0, dot) : username;
}

/** The sandbox's name a username ends with, `.uat`; none for another org's user. */
function sandboxSuffixOf(username: string | undefined): string | undefined {
  if (username === undefined) return undefined;
  const base = withoutSandboxSuffix(username);
  return base === username ? undefined : username.slice(base.length);
}

/**
 * Read the other org for what the survey asks: one describe per object
 * replayed, the users, record types, queues, currencies and standard price
 * book the records need, and the records it holds under the same Ids — 200
 * of each object first, every one only when some are there.
 *
 * @throws What the org answers a read with, but a describe: an object it
 *   does not have is named among those not replayed.
 */
export async function readReplayTarget(read: ReplayTargetRead): Promise<ReplayTarget> {
  const { access, orgId, survey, source } = read;
  let requests = 0;
  const query = async (soql: string): Promise<Array<Record<string, unknown>>> => {
    requests++;
    return access.query(orgId, soql);
  };

  const describes = new Map<string, TargetObjectDescribe>();
  const missing = new Map<string, string>();
  const describeOf = async (objectApiName: string): Promise<void> => {
    requests++;
    try {
      describes.set(objectApiName, await access.describe(orgId, objectApiName));
    } catch (err: unknown) {
      missing.set(objectApiName, extractErrorMessage(err));
    }
  };
  for (const object of survey.objects.replayed) await describeOf(object.objectApiName);
  if (survey.fileLinks.length > 0) await describeOf(FILE_LINK_OBJECT);

  // Users: those the records name, and the owners chosen, by Id; then, with
  // the annex, the same people under their usernames.
  const usersById = new Map<string, ReplayTargetUser>();
  const userOf = (row: Record<string, unknown>): ReplayTargetUser | undefined =>
    typeof row.Id === 'string' && typeof row.Username === 'string'
      ? {
          id: eighteen(row.Id),
          username: row.Username,
          isActive: row.IsActive === true,
          userType: typeof row.UserType === 'string' ? row.UserType : '',
        }
      : undefined;
  const askedUsers = [
    ...new Set([...survey.users, ...Object.values(source.choices.ownerMap ?? {}).map(keyOf)]),
  ].sort();
  for (const group of chunks(askedUsers, IDS_PER_READ)) {
    for (const row of await query(
      `SELECT Id, Username, IsActive, UserType FROM User WHERE Id IN (${idList(group)})`,
    )) {
      const user = userOf(row);
      if (user) usersById.set(keyOf(user.id), user);
    }
  }
  const usersByUsername = new Map<string, ReplayTargetUser>();
  if (annexHas(source.annex, 'users')) {
    const suffix = read.tier === 'sandbox' ? sandboxSuffixOf(read.username) : undefined;
    const candidates = new Map<string, string[]>();
    for (const user of source.annex.users) {
      const key = keyOf(user.id);
      const kept = usersById.get(key);
      if (kept?.isActive === true && kept.userType === 'Standard') continue;
      const base =
        source.checkpoint.org.tier === 'sandbox'
          ? withoutSandboxSuffix(user.username)
          : user.username;
      const names = [user.username, base, ...(suffix !== undefined ? [`${base}${suffix}`] : [])];
      candidates.set(key, [...new Set(names.map((name) => name.toLowerCase()))]);
    }
    const asked = [...new Set([...candidates.values()].flat())].sort();
    const found = new Map<string, ReplayTargetUser>();
    for (const group of chunks(asked, IDS_PER_READ)) {
      const list = group.map((name) => `'${sanitizeSoqlValue(name)}'`).join(', ');
      for (const row of await query(
        `SELECT Id, Username, IsActive, UserType FROM User WHERE Username IN (${list})`,
      )) {
        const user = userOf(row);
        if (user) found.set(user.username.toLowerCase(), user);
      }
    }
    for (const [key, names] of candidates) {
      const user = names.map((name) => found.get(name)).find((each) => each !== undefined);
      if (user) usersByUsername.set(key, user);
    }
  }

  // Record types of the objects replayed, with whether each is a person
  // account's where the org has them: the column is not there otherwise.
  const recordTypes: ReplayTargetRecordType[] = [];
  const typed = [...describes.keys()].filter((name) =>
    describes.get(name)?.fields.some((field) => field.name === RECORD_TYPE_FIELD),
  );
  if (typed.length > 0) {
    const personAccounts = hasPersonAccounts(describes);
    const rows = await query(
      'SELECT Id, SobjectType, DeveloperName, NamespacePrefix, Name, IsActive' +
        `${personAccounts ? ', IsPersonType' : ''} FROM RecordType WHERE SobjectType IN ` +
        `(${typed.map((name) => `'${assertSoqlIdentifier(name)}'`).join(', ')})`,
    );
    for (const row of rows) {
      if (
        typeof row.Id !== 'string' ||
        typeof row.SobjectType !== 'string' ||
        typeof row.DeveloperName !== 'string'
      ) {
        continue;
      }
      recordTypes.push({
        id: eighteen(row.Id),
        sobjectType: row.SobjectType,
        developerName: row.DeveloperName,
        ...(typeof row.NamespacePrefix === 'string' && row.NamespacePrefix !== ''
          ? { namespacePrefix: row.NamespacePrefix }
          : {}),
        name: typeof row.Name === 'string' ? row.Name : row.DeveloperName,
        isActive: row.IsActive !== false,
        ...(typeof row.IsPersonType === 'boolean' ? { isPersonType: row.IsPersonType } : {}),
      });
    }
  }

  const queues: Array<{ id: string; developerName: string; sobjectTypes: string[] }> = [];
  if (survey.queues.size > 0) {
    const taken = new Map<string, string[]>();
    for (const row of await query('SELECT QueueId, SobjectType FROM QueueSobject')) {
      if (typeof row.QueueId !== 'string' || typeof row.SobjectType !== 'string') continue;
      taken.set(keyOf(row.QueueId), [...(taken.get(keyOf(row.QueueId)) ?? []), row.SobjectType]);
    }
    for (const row of await query("SELECT Id, DeveloperName FROM Group WHERE Type = 'Queue'")) {
      if (typeof row.Id !== 'string' || typeof row.DeveloperName !== 'string') continue;
      queues.push({
        id: eighteen(row.Id),
        developerName: row.DeveloperName,
        sobjectTypes: taken.get(keyOf(row.Id)) ?? [],
      });
    }
  }

  // An org of one currency describes no currency field: it takes amounts as
  // they are, and has no CurrencyType to read.
  let currencies: Set<string> | undefined;
  const priced = [...describes.values()].some((describe) =>
    describe.fields.some((field) => field.name === CURRENCY_FIELD),
  );
  if (priced && survey.currencies.size > 0) {
    currencies = new Set();
    for (const row of await query('SELECT IsoCode, IsActive FROM CurrencyType')) {
      if (typeof row.IsoCode === 'string' && row.IsActive === true) currencies.add(row.IsoCode);
    }
  }

  let standardPricebookId: string | undefined;
  if (survey.standardPricebook.id !== undefined) {
    const [book] = await query(STANDARD_PRICEBOOK_SOQL);
    if (typeof book?.Id === 'string') standardPricebookId = eighteen(book.Id);
  }

  // The records it holds under the checkpoint's Ids: 200 of each object
  // first, and every one when any is there — a sandbox copied from the same
  // production holds them all, any other org none.
  const sameIds = new Set<string>();
  const byObject = new Map<string, string[]>();
  for (const [key, objectApiName] of survey.heldBy) {
    byObject.set(objectApiName, [...(byObject.get(objectApiName) ?? []), key]);
  }
  const probe = async (objectApiName: string, keys: readonly string[]): Promise<number> => {
    let found = 0;
    for (const group of chunks(keys, IDS_PER_READ)) {
      for (const row of await query(
        `SELECT Id FROM ${assertSoqlIdentifier(objectApiName)} WHERE Id IN (${idList(group)})`,
      )) {
        if (typeof row.Id === 'string') {
          sameIds.add(keyOf(row.Id));
          found++;
        }
      }
    }
    return found;
  };
  const replayedNames = new Set(survey.objects.replayed.map((object) => object.objectApiName));
  for (const [objectApiName, keys] of byObject) {
    if (missing.has(objectApiName) || holdsFileContent(objectApiName)) continue;
    const sorted = [...keys].sort();
    const first = sorted.slice(0, IDS_PER_READ);
    try {
      if ((await probe(objectApiName, first)) > 0) {
        await probe(objectApiName, sorted.slice(IDS_PER_READ));
      }
    } catch (err: unknown) {
      // An object the replay does not set up, which the other org does not
      // have or will not read, holds none of its records under their Ids.
      if (replayedNames.has(objectApiName)) throw err;
    }
  }
  // Ids of records the checkpoint does not hold, in a lookup to one object:
  // the records a sandbox copied from the same production shares with it.
  const notHeldByObject = new Map<string, Set<string>>();
  for (const [at, keys] of survey.notHeld) {
    const [objectApiName, field] = at.split('.');
    const described = describes.get(objectApiName)?.fields.find((each) => each.name === field);
    const to = described?.type === 'reference' ? (described.referenceTo ?? []) : [];
    if (to.length !== 1) continue;
    const seen = notHeldByObject.get(to[0]) ?? new Set<string>();
    for (const key of keys) seen.add(key);
    notHeldByObject.set(to[0], seen);
  }
  for (const [objectApiName, keys] of notHeldByObject) {
    try {
      await probe(objectApiName, [...keys].sort());
    } catch {
      // An object the other org will not read holds nothing a lookup links to.
    }
  }

  const customSettings = new Map<string, { names: Set<string>; owners: Set<string> }>();
  for (const object of survey.objects.replayed) {
    if (object.customSetting === undefined || missing.has(object.objectApiName)) continue;
    const held = { names: new Set<string>(), owners: new Set<string>() };
    for (const row of await query(
      `SELECT Id, Name, SetupOwnerId FROM ${assertSoqlIdentifier(object.objectApiName)}`,
    )) {
      if (typeof row.Name === 'string') held.names.add(row.Name);
      if (typeof row.SetupOwnerId === 'string') held.owners.add(keyOf(row.SetupOwnerId));
    }
    customSettings.set(object.objectApiName, held);
  }
  const profiles = new Set<string>();
  for (const group of chunks([...survey.profiles].sort(), IDS_PER_READ)) {
    for (const row of await query(`SELECT Id FROM Profile WHERE Id IN (${idList(group)})`)) {
      if (typeof row.Id === 'string') profiles.add(keyOf(row.Id));
    }
  }
  const files = new Set<string>();
  const documents = [...new Set(survey.fileLinks.map((link) => keyOf(link.ContentDocumentId)))];
  if (!missing.has(FILE_LINK_OBJECT)) {
    for (const group of chunks(documents.sort(), IDS_PER_READ)) {
      for (const row of await query(
        `SELECT Id FROM ContentDocument WHERE Id IN (${idList(group)})`,
      )) {
        if (typeof row.Id === 'string') files.add(keyOf(row.Id));
      }
    }
  }

  return {
    organizationId: eighteen(read.organizationId),
    runningUserId: eighteen(read.runningUserId),
    describes,
    missing,
    usersById,
    usersByUsername,
    recordTypes,
    queues,
    ...(currencies !== undefined ? { currencies } : {}),
    ...(standardPricebookId !== undefined ? { standardPricebookId } : {}),
    sameIds,
    customSettings,
    profiles,
    files,
    requests,
  };
}

/** Whether an org has person accounts: only such an org describes the flag on an account. */
function hasPersonAccounts(describes: ReadonlyMap<string, TargetObjectDescribe>): boolean {
  return (
    describes.get('Account')?.fields.some((field) => field.name === PERSON_ACCOUNT_FLAG) === true
  );
}

// ─── 3. The conversion ───────────────────────────────────────────────────────

/** Why a replay is refused once the other org is read: an owner chosen it will not take. */
export interface ReplayOwnerMapRefusal {
  code: 'OWNER_MAP_INACTIVE' | 'OWNER_MAP_UNKNOWN';
  message: string;
  /** The users of the other org refused, by id. */
  users: string[];
}

/**
 * The refusal of an owner mapping that gives records to users the other org
 * holds inactive, or does not hold as standard users: the target refuses
 * every record either would own, and the replay never gives them to the user
 * who replays instead of the one chosen.
 */
export function ownerMapRefusalOf(
  choices: Pick<CheckpointReplayChoices, 'ownerMap'>,
  target: Pick<ReplayTarget, 'usersById'>,
  targetName: string,
): ReplayOwnerMapRefusal | undefined {
  const chosen = [...new Set(Object.values(choices.ownerMap ?? {}).map(keyOf))].sort();
  const unknown = chosen.filter((key) => {
    const user = target.usersById.get(key);
    return user === undefined || user.userType !== 'Standard';
  });
  if (unknown.length > 0) {
    return {
      code: 'OWNER_MAP_UNKNOWN',
      users: unknown.map(eighteen),
      message:
        `The owners chosen give records to users ${targetName} does not hold as standard ` +
        `users: ${unknown.map(eighteen).join(', ')}. Choose users of ${targetName}. ` +
        'Nothing was written.',
    };
  }
  const inactive = chosen.filter((key) => target.usersById.get(key)?.isActive !== true);
  if (inactive.length > 0) {
    return {
      code: 'OWNER_MAP_INACTIVE',
      users: inactive.map(eighteen),
      message:
        `The owners chosen give records to users ${targetName} holds inactive: ` +
        `${inactive.map(eighteen).join(', ')}. It refuses a record owned by an inactive user: ` +
        'choose an active user, or reactivate them there. Nothing was written.',
    };
  }
  return undefined;
}

/** A converted checkpoint: what the loader loads, and what does not go across as it was. */
export interface ReplayConversion {
  dataset: FrozenDataset;
  summary: CheckpointReplaySummary;
  /** `--link Object=Field`: the load's identity keys, which link a record the other org holds by them. */
  identityKeys: Record<string, string[]>;
  /** By key, the Id of each record of the checkpoint the other org holds under it: linked, never written. */
  linkedById: ReadonlyMap<string, string>;
  /** Each file left where it was, named: the summary counts them, this says which. */
  filesLeft: readonly ReplayFileLeft[];
}

/** What a conversion is given. */
export interface ReplayConversionInput extends ReplaySource {
  survey: ReplaySurvey;
  target: ReplayTarget;
  /** What the other org is named by in a path. */
  targetName: string;
  /** The key the contact points and the masked values are drawn with; random unless a test names one. */
  salt?: string;
}

/** A record on its way, before what its lookups name is known to go. */
interface Draft {
  objectApiName: string;
  key: string;
  referenceId: string;
  fields: Record<string, unknown>;
  /** Its lookups to records the replay creates, by field, each record's key. */
  pointsAt: Map<string, string>;
  /** Set once it is refused before any write. */
  refused?: { reason: CheckpointReplayRefusedReason; path?: string };
  recordTypeDeveloperName?: string;
  sourceId: string;
  /** What became of its owner: counted once it is known to go. */
  owner?: 'kept' | 'toRunningUser' | 'notInTarget' | 'inactive' | 'queueMissing';
  /** Its record type, and how it was found. */
  recordType?: { recordType: string; outcome: 'byName' | 'byId' | 'default' };
  /** Its lookups emptied, and why. */
  emptied: Array<{ field: string; reason: CheckpointReplayLookupEmptiedReason }>;
}

/** Counts by a key, in the order first met. */
class Tally<K> {
  private readonly counts = new Map<string, { key: K; n: number }>();
  constructor(private readonly id: (key: K) => string) {}
  add(key: K, n = 1): void {
    const at = this.id(key);
    const held = this.counts.get(at);
    if (held) held.n += n;
    else this.counts.set(at, { key, n });
  }
  entries(): Array<{ key: K; n: number }> {
    return [...this.counts.values()];
  }
}

/** Whether the other org requires a lookup at insert: never empty, and not given a default. */
function requiredLookup(objectApiName: string, field: TargetFieldDescribe): boolean {
  return (
    (field.createable && field.nillable === false && field.defaultedOnCreate !== true) ||
    isPlatformRequiredField(objectApiName, field.name)
  );
}

/** The length a describe gives a field, when it gives one. */
function lengthOf(field: TargetFieldDescribe): number | undefined {
  const length = (field as TargetFieldDescribe & { length?: unknown }).length;
  return typeof length === 'number' && length > 0 ? length : undefined;
}

/** The types whose values are no personal datum a masking reads: ids, flags, numbers and dates. */
const NOT_MASKED_TYPES: ReadonlySet<string> = new Set([
  'id',
  'reference',
  'boolean',
  'double',
  'int',
  'long',
  'percent',
  'currency',
  'date',
  'datetime',
  'time',
  'picklist',
  'multipicklist',
]);

/**
 * Convert the checkpoint: see the module's comment. Refused when the owners
 * chosen are users the other org will not give records to.
 */
export async function checkpointToDataset(
  input: ReplayConversionInput,
): Promise<{ conversion: ReplayConversion } | { refusal: ReplayOwnerMapRefusal }> {
  const { survey, target, choices, annex } = input;
  const ownerRefusal = ownerMapRefusalOf(choices, target, input.targetName);
  if (ownerRefusal) return { refusal: ownerRefusal };

  const notReplayed = new Tally<{ object: string; reason: CheckpointReplayNotReplayedReason }>(
    (k) => `${k.object}|${k.reason}`,
  );
  for (const left of survey.objects.leftOut) {
    notReplayed.add({ object: left.objectApiName, reason: left.reason }, left.records);
  }
  const replayed = survey.objects.replayed.filter((object) => {
    if (target.missing.has(object.objectApiName)) {
      notReplayed.add({ object: object.objectApiName, reason: 'notInTarget' }, object.records);
      return false;
    }
    if (target.describes.get(object.objectApiName)?.createable === false) {
      notReplayed.add({ object: object.objectApiName, reason: 'notCreateable' }, object.records);
      return false;
    }
    return true;
  });
  const replayedObjects = new Set(replayed.map((object) => object.objectApiName));

  const lookupsEmptied = new Tally<{ field: string; reason: CheckpointReplayLookupEmptiedReason }>(
    (k) => `${k.field}|${k.reason}`,
  );
  const owners = {
    kept: 0,
    toRunningUser: 0,
    reasons: { notInTarget: 0, inactive: 0, queueMissing: 0 },
  };
  const recordTypeTally = new Tally<{
    object: string;
    recordType: string;
    outcome: 'byName' | 'byId' | 'default';
  }>((k) => `${k.object}|${k.recordType}|${k.outcome}`);
  const currencyRefused = new Tally<string>((code) => code);
  const fieldsNotInTarget = new Map<string, Set<string>>();
  let singleCurrencyTarget = false;
  const customSettings = { inserted: 0, alreadyThere: 0 };
  const linkedById = new Map<string, string>();
  const recordTypeRefs = new Map<string, Map<string, FrozenRecordTypeRef>>();
  const personAccounts = hasPersonAccounts(target.describes);
  const personContacts = new Set<string>();
  const standardBook = survey.standardPricebook;
  const standardKey = standardBook.id !== undefined ? keyOf(standardBook.id) : undefined;
  const ownerMap = new Map(
    Object.entries(choices.ownerMap ?? {}).map(([from, to]) => [keyOf(from), eighteen(to)]),
  );

  /** The other org's user a user of the checkpoint is: an active standard one, or why none. */
  const sameUser = (key: string): { id?: string; why?: 'notInTarget' | 'inactive' } => {
    const byId = target.usersById.get(key);
    if (byId?.userType === 'Standard' && byId.isActive) return { id: byId.id };
    const byName = target.usersByUsername.get(key);
    if (byName?.userType === 'Standard' && byName.isActive) return { id: byName.id };
    return { why: byId !== undefined || byName !== undefined ? 'inactive' : 'notInTarget' };
  };

  /** The other org's queue an owner of the checkpoint is: by Id, else by the annex's developer name. */
  const queueOf = (objectApiName: string, key: string): string | undefined => {
    const takes = (queue: ReplayTarget['queues'][number]): boolean =>
      queue.sobjectTypes.includes(objectApiName);
    const byId = target.queues.find((queue) => keyOf(queue.id) === key && takes(queue));
    if (byId) return byId.id;
    const known = annexHas(annex, 'queues')
      ? annex.queues.find((queue) => keyOf(queue.id) === key)
      : undefined;
    if (known === undefined) return undefined;
    return target.queues.find(
      (queue) => queue.developerName === known.developerName && takes(queue),
    )?.id;
  };

  /** The record type a record of `objectApiName` goes in as, or why it is refused. */
  const recordTypeOf = (
    objectApiName: string,
    sourceId: string,
    person: boolean,
  ): {
    ref?: FrozenRecordTypeRef;
    refused?: string;
    given?: NonNullable<Draft['recordType']>;
  } => {
    const key = keyOf(sourceId);
    const known = annexHas(annex, 'recordTypes')
      ? annex.recordTypes.find((type) => keyOf(type.id) === key)
      : undefined;
    const ofObject = target.recordTypes.filter(
      (type) => type.sobjectType === objectApiName && type.isActive,
    );
    let found: ReplayTargetRecordType | undefined;
    let outcome: 'byName' | 'byId' | 'default' = 'default';
    if (known !== undefined) {
      found = ofObject.find(
        (type) =>
          type.developerName === known.developerName &&
          (type.namespacePrefix ?? null) === (known.namespacePrefix ?? null),
      );
      if (found) outcome = 'byName';
    }
    if (found === undefined) {
      found = ofObject.find((type) => keyOf(type.id) === key);
      if (found) outcome = 'byId';
    }
    if (found === undefined && person) {
      // The other org's default for an account is a business account's: a
      // person account goes in as the one person account type it has.
      const personTypes = ofObject.filter((type) => type.isPersonType === true);
      if (personTypes.length !== 1) {
        return {
          refused:
            'the checkpoint does not say which of the person account record types of ' +
            `${input.targetName} its person accounts had: take it again with SandForge 1.81 or ` +
            'later, or leave Account out',
        };
      }
      found = personTypes[0];
    }
    const given = {
      recordType:
        known !== undefined
          ? qualifiedRecordTypeName(known.namespacePrefix, known.developerName)
          : eighteen(sourceId),
      outcome,
    };
    if (found === undefined) return { given };
    const chosen = found;
    const info = target.describes
      .get(objectApiName)
      ?.recordTypeInfos?.find((each) => keyOf(each.recordTypeId) === keyOf(chosen.id));
    if (info !== undefined && !info.available) {
      return {
        refused:
          `${qualifiedRecordTypeName(chosen.namespacePrefix, chosen.developerName)} is not ` +
          `assigned to the user who replays in ${input.targetName}: assign it to them, or leave ` +
          `${objectApiName} out`,
      };
    }
    const ref: FrozenRecordTypeRef = {
      name: chosen.name,
      developerName: chosen.developerName,
      namespacePrefix: chosen.namespacePrefix ?? null,
    };
    const refs = recordTypeRefs.get(objectApiName) ?? new Map<string, FrozenRecordTypeRef>();
    refs.set(chosen.id, ref);
    recordTypeRefs.set(objectApiName, refs);
    return { ref, given };
  };

  const drafts: Draft[] = [];
  for (const object of replayed) {
    const objectApiName = object.objectApiName;
    const describe = target.describes.get(objectApiName);
    if (describe === undefined) continue;
    const fields = new Map(describe.fields.map((field) => [field.name, field]));
    const absent = object.fields.filter(
      (field) =>
        !NEVER_SENT.has(field) &&
        !fields.has(field) &&
        !(field === CURRENCY_FIELD && target.currencies === undefined),
    );
    if (absent.length > 0) fieldsNotInTarget.set(objectApiName, new Set(absent));
    const setting = object.customSetting;
    const heldSettings = target.customSettings.get(objectApiName);

    for await (const record of recordsOf(input, objectApiName)) {
      const key = keyOf(record.Id);
      if (target.sameIds.has(key)) {
        linkedById.set(replayReferenceIdOf(objectApiName, record.Id), eighteen(record.Id));
        continue;
      }
      const draft: Draft = {
        objectApiName,
        key,
        referenceId: replayReferenceIdOf(objectApiName, record.Id),
        fields: {},
        pointsAt: new Map(),
        sourceId: eighteen(record.Id),
        emptied: [],
      };
      const refuse = (reason: CheckpointReplayRefusedReason, path?: string): void => {
        draft.refused ??= { reason, ...(path !== undefined ? { path } : {}) };
      };
      const person =
        (objectApiName === 'Account' || objectApiName === 'Contact') && isPersonAccountRow(record);
      if (person && !personAccounts) {
        refuse(
          'personAccountsUnsupported',
          `turn person accounts on in ${input.targetName}, or leave ${objectApiName} out`,
        );
      }
      if (person && objectApiName === 'Contact') personContacts.add(key);
      const kind = objectApiName === 'Account' ? accountKindOf(record, false) : undefined;

      for (const [field, value] of Object.entries(record)) {
        if (NEVER_SENT.has(field)) continue;
        if (kind !== undefined && leftOutForAccountKind(objectApiName, field, kind)) continue;
        const described = fields.get(field);
        if (described === undefined) {
          if (field === CURRENCY_FIELD && typeof value === 'string' && value !== '') {
            singleCurrencyTarget ||= target.currencies === undefined;
          }
          continue;
        }
        if (value === null || value === undefined || value === '') continue;
        if (field === CURRENCY_FIELD && typeof value === 'string') {
          if (target.currencies !== undefined && !target.currencies.has(value)) {
            refuse(
              'inactiveCurrency',
              `activate ${value} in ${input.targetName}, or leave ${objectApiName} out`,
            );
            currencyRefused.add(value);
          }
          draft.fields[field] = value;
          continue;
        }
        if (field === RECORD_TYPE_FIELD && typeof value === 'string') {
          const given = recordTypeOf(objectApiName, value, person);
          if (given.given !== undefined) draft.recordType = given.given;
          if (given.refused !== undefined) refuse('recordTypeUnavailable', given.refused);
          else if (given.ref !== undefined) {
            draft.fields[field] = given.ref.name;
            draft.recordTypeDeveloperName = qualifiedRecordTypeName(
              given.ref.namespacePrefix,
              given.ref.developerName,
            );
          }
          continue;
        }
        if (described.type !== 'reference' || typeof value !== 'string' || !ID_SHAPE.test(value)) {
          draft.fields[field] = value;
          continue;
        }
        const lookupKey = keyOf(value);
        const required = requiredLookup(objectApiName, described);
        const empty = (reason: CheckpointReplayLookupEmptiedReason, path: string): void => {
          if (required) refuse('requiredLookupMissing', path);
          else draft.emptied.push({ field: `${objectApiName}.${field}`, reason });
        };
        // A hierarchy setting's org-wide row belongs to the other org there.
        if (lookupKey.startsWith(ORG_PREFIX)) {
          draft.fields[field] = target.organizationId;
          continue;
        }
        if (field === SETUP_OWNER_FIELD) {
          // A row of a profile or a user: kept for the same one there, never
          // given to the org, which would make it everyone's.
          const there = lookupKey.startsWith(PROFILE_PREFIX)
            ? target.profiles.has(lookupKey)
            : target.usersById.has(lookupKey);
          if (there) draft.fields[field] = eighteen(value);
          else {
            refuse(
              'requiredLookupMissing',
              `the ${lookupKey.startsWith(PROFILE_PREFIX) ? 'profile' : 'user'} its row is of ` +
                `is not in ${input.targetName}`,
            );
          }
          continue;
        }
        if (
          field === OWNER_FIELD &&
          (lookupKey.startsWith(USER_PREFIX) || lookupKey.startsWith(QUEUE_PREFIX))
        ) {
          const mapped = ownerMap.get(lookupKey);
          if (mapped !== undefined) {
            draft.owner = 'kept';
            draft.fields[field] = mapped;
          } else if (choices.owners === 'me') {
            draft.owner = 'toRunningUser';
          } else if (lookupKey.startsWith(QUEUE_PREFIX)) {
            const queue = queueOf(objectApiName, lookupKey);
            draft.owner = queue !== undefined ? 'kept' : 'queueMissing';
            if (queue !== undefined) draft.fields[field] = queue;
          } else {
            const user = sameUser(lookupKey);
            draft.owner = user.id !== undefined ? 'kept' : (user.why ?? 'notInTarget');
            if (user.id !== undefined) draft.fields[field] = user.id;
          }
          continue;
        }
        if (lookupKey.startsWith(USER_PREFIX)) {
          const user = sameUser(lookupKey);
          if (user.id !== undefined) draft.fields[field] = user.id;
          else if (required) draft.fields[field] = target.runningUserId;
          else
            draft.emptied.push({ field: `${objectApiName}.${field}`, reason: 'userNotInTarget' });
          continue;
        }
        // The standard price book: the other org's own, matched, never made.
        if (standardKey !== undefined && lookupKey === standardKey) {
          if (target.sameIds.has(lookupKey)) {
            // A sandbox copied from the same production: its own, under the same Id.
            draft.fields[field] = eighteen(value);
          } else if (replayedObjects.has(PRICEBOOK_OBJECT) && survey.heldBy.has(lookupKey)) {
            draft.pointsAt.set(field, lookupKey);
          } else if (target.standardPricebookId !== undefined) {
            draft.fields[field] = target.standardPricebookId;
          } else {
            empty('objectNotHeld', `${input.targetName} has no standard price book`);
          }
          continue;
        }
        const heldIn = survey.heldBy.get(lookupKey);
        if (heldIn !== undefined && target.sameIds.has(lookupKey)) {
          draft.fields[field] = eighteen(value);
        } else if (heldIn !== undefined && replayedObjects.has(heldIn)) {
          draft.pointsAt.set(field, lookupKey);
        } else if (heldIn !== undefined) {
          empty('objectNotReplayed', `replay ${heldIn} too`);
        } else if (target.sameIds.has(lookupKey)) {
          draft.fields[field] = eighteen(value);
        } else {
          empty(
            'objectNotHeld',
            `the checkpoint holds no record it points at, and ${input.targetName} holds none ` +
              'under its Id',
          );
        }
      }

      if (objectApiName === PRICEBOOK_ENTRY_OBJECT && standardBook.how === 'ambiguous') {
        refuse(
          'requiredLookupMissing',
          'the checkpoint does not say which of its price books is the standard one, which ' +
            'every other price needs first: take it again with SandForge 1.81 or later, or ' +
            `leave ${PRICEBOOK_ENTRY_OBJECT} out`,
        );
      }
      if (setting !== undefined && heldSettings !== undefined) {
        const owner = draft.fields[SETUP_OWNER_FIELD];
        const there =
          setting === 'list'
            ? typeof record.Name === 'string' && heldSettings.names.has(record.Name)
            : typeof owner === 'string' && heldSettings.owners.has(keyOf(owner));
        if (there) {
          customSettings.alreadyThere++;
          continue;
        }
      }
      drafts.push(draft);
    }
  }

  // A record whose lookup names a record refused is refused too, and so on:
  // written without its parent, it would stand for what it is not.
  const byKey = new Map(drafts.map((draft) => [draft.key, draft]));
  const dependents = new Map<string, Draft[]>();
  for (const draft of drafts) {
    for (const parent of draft.pointsAt.values()) {
      dependents.set(parent, [...(dependents.get(parent) ?? []), draft]);
    }
  }
  const waiting = drafts.filter((draft) => draft.refused !== undefined);
  for (let at = 0; at < waiting.length; at++) {
    const refused = waiting[at];
    for (const child of dependents.get(refused.key) ?? []) {
      if (child.refused !== undefined) continue;
      child.refused = {
        reason: 'parentRefused',
        path: `its ${refused.objectApiName} is refused: lift that first`,
      };
      waiting.push(child);
    }
  }
  const refusedTally = new Tally<{
    object: string;
    reason: CheckpointReplayRefusedReason;
    path?: string;
  }>((k) => `${k.object}|${k.reason}`);

  const records = new Map<string, FrozenRecord[]>();
  const personContactSidecar: PersonContactLink[] = [];
  for (const draft of drafts) {
    if (draft.refused !== undefined) {
      refusedTally.add({ object: draft.objectApiName, ...draft.refused });
      continue;
    }
    for (const emptied of draft.emptied) lookupsEmptied.add(emptied);
    if (draft.recordType !== undefined) {
      recordTypeTally.add({ object: draft.objectApiName, ...draft.recordType });
    }
    if (draft.owner === 'kept') owners.kept++;
    else if (draft.owner !== undefined) {
      owners.toRunningUser++;
      if (draft.owner !== 'toRunningUser') owners.reasons[draft.owner]++;
    }
    for (const [field, parent] of draft.pointsAt) {
      const parentDraft = byKey.get(parent);
      if (parentDraft !== undefined && parentDraft.refused === undefined) {
        draft.fields[field] = parentDraft.referenceId;
      } else {
        // A row of a custom setting the other org holds already.
        lookupsEmptied.add({
          field: `${draft.objectApiName}.${field}`,
          reason: 'objectNotReplayed',
        });
      }
    }
    if (personContacts.has(draft.key) && typeof draft.fields.AccountId === 'string') {
      personContactSidecar.push({
        accountReferenceId: draft.fields.AccountId,
        contactReferenceId: draft.referenceId,
      });
    }
    const list = records.get(draft.objectApiName) ?? [];
    list.push({
      referenceId: draft.referenceId,
      fields: draft.fields,
      ...(draft.recordTypeDeveloperName !== undefined
        ? { recordTypeDeveloperName: draft.recordTypeDeveloperName }
        : {}),
    });
    records.set(draft.objectApiName, list);
  }
  for (const object of replayed) {
    if (object.customSetting === undefined) continue;
    customSettings.inserted += records.get(object.objectApiName)?.length ?? 0;
  }

  // A file the other org holds under the same Id is linked again to the
  // records replayed it was linked to: a sandbox copied from the same
  // production holds the files of the records the replay creates.
  const linkDescribe = target.describes.get(FILE_LINK_OBJECT);
  if (linkDescribe !== undefined && linkDescribe.createable !== false) {
    const links: FrozenRecord[] = [];
    for (const link of survey.fileLinks) {
      const record = byKey.get(keyOf(link.LinkedEntityId));
      if (record === undefined || record.refused !== undefined) continue;
      if (!target.files.has(keyOf(link.ContentDocumentId))) continue;
      links.push({
        // One dash, as a key's object is read up to its last one.
        referenceId: `${FILE_LINK_OBJECT}-${eighteen(link.ContentDocumentId)}_${record.sourceId}`,
        fields: {
          ContentDocumentId: eighteen(link.ContentDocumentId),
          LinkedEntityId: record.referenceId,
          ShareType: link.ShareType,
          Visibility: link.Visibility,
        },
      });
    }
    if (links.length > 0) records.set(FILE_LINK_OBJECT, links);
  }

  // Contact points, then masking: what the replay writes never reaches a
  // real person unless asked, and personal data goes masked when asked.
  const neutralizer = new ContactPointNeutralizer(input.salt);
  const anonymizer = choices.mask ? new ForgeAnonymizer(undefined, input.salt) : undefined;
  const detector = choices.mask ? new PIIDetector() : undefined;
  const masked: string[] = [];
  const unmaskedFreeText: string[] = [];
  for (const [objectApiName, list] of records) {
    const describe = target.describes.get(objectApiName);
    if (describe === undefined) continue;
    const present = new Set(list.flatMap((record) => Object.keys(record.fields)));
    const infos: FieldInfo[] = describe.fields
      .filter((field) => present.has(field.name))
      .map((field) => {
        const length = lengthOf(field);
        return {
          name: field.name,
          queryable: true,
          createable: field.createable,
          isReference: field.type === 'reference',
          type: field.type,
          ...(length !== undefined ? { length } : {}),
        };
      });
    if (choices.contactPoints === 'neutralized') {
      const neutralize = neutralizer.forObject(objectApiName, infos);
      if (neutralize) for (const record of list) neutralize(record.fields);
    }
    if (anonymizer === undefined || detector === undefined) continue;
    const candidates = infos.filter(
      (info) => !NOT_MASKED_TYPES.has((info.type ?? '').toLowerCase()),
    );
    const personal = new Set(
      personalFieldsByApiName(
        detector,
        candidates.map((info) => ({ name: info.name, type: info.type ?? 'string' })),
      ),
    );
    const piiFields: PIIFieldInfo[] = candidates
      .filter((info) => personal.has(info.name))
      .map((info) => ({
        name: info.name,
        type: info.type ?? 'string',
        ...(info.length !== undefined ? { length: info.length } : {}),
      }));
    for (const field of piiFields) masked.push(`${objectApiName}.${field.name}`);
    for (const info of candidates) {
      if (!personal.has(info.name) && (info.type ?? '').toLowerCase() === 'textarea') {
        unmaskedFreeText.push(`${objectApiName}.${info.name}`);
      }
    }
    if (piiFields.length === 0) continue;
    const anonymized = anonymizer.anonymize({
      objectApiName,
      records: list.map((record) => record.fields),
      sourceIds: list.map((record) => record.referenceId),
      fields: piiFields,
      methods: {},
    });
    list.forEach((record, index) => {
      record.fields = anonymized[index] ?? record.fields;
    });
  }

  const recordTypes: Record<string, FrozenRecordTypeRef[]> = {};
  for (const [objectApiName, refs] of recordTypeRefs)
    recordTypes[objectApiName] = [...refs.values()];
  const objects = [...records].map(([objectApiName, list]) => ({ objectApiName, records: list }));
  const standardDraft = standardKey !== undefined ? byKey.get(standardKey) : undefined;
  const standardRef =
    standardDraft !== undefined &&
    standardDraft.refused === undefined &&
    standardDraft.objectApiName === PRICEBOOK_OBJECT
      ? standardDraft.referenceId
      : undefined;
  const dataset: FrozenDataset = {
    datasetVersion: '1.0.0',
    objects,
    recordTypes,
    personContactSidecar,
    ...(standardRef !== undefined ? { standardPricebook: standardRef } : {}),
  };
  const written = objects.reduce((sum, object) => sum + object.records.length, 0);
  const catalog = survey.objects.replayed.some(
    (object) =>
      object.objectApiName === PRICEBOOK_OBJECT || object.objectApiName === PRICEBOOK_ENTRY_OBJECT,
  );
  const refused = refusedTally.entries();
  const summary: CheckpointReplaySummary = {
    records: {
      // The standard price book is matched to the other org's, never made.
      toCreate: written - (standardRef !== undefined ? 1 : 0),
      linkedById: linkedById.size,
      linkedByKey: 0,
      refusedBeforeWrite: refused.reduce((sum, each) => sum + each.n, 0),
    },
    owners,
    recordTypes: recordTypeTally
      .entries()
      .map(({ key, n }) => ({ ...key, records: n }))
      .sort((a, b) => compare(`${a.object}.${a.recordType}`, `${b.object}.${b.recordType}`)),
    notReplayed: notReplayed.entries().map(({ key, n }) => ({ ...key, records: n })),
    lookupsEmptied: lookupsEmptied
      .entries()
      .map(({ key, n }) => ({ ...key, records: n }))
      .sort((a, b) => compare(a.field, b.field)),
    refused: refused.map(({ key, n }) => ({
      object: key.object,
      records: n,
      reason: key.reason,
      ...(key.path !== undefined ? { path: key.path } : {}),
    })),
    fieldsNotInTarget: [...fieldsNotInTarget].map(([object, fields]) => ({
      object,
      fields: [...fields].sort(),
    })),
    ...(survey.objects.replayed.some((object) => object.customSetting !== undefined)
      ? { customSettings }
      : {}),
    currencies: {
      refused: currencyRefused.entries().map(({ key, n }) => ({ code: key, records: n })),
      ...(singleCurrencyTarget ? { singleCurrencyTarget: true as const } : {}),
    },
    ...(catalog ? { standardPricebook: standardBook.how } : {}),
    masked: {
      fields: masked.sort(),
      ...(choices.mask ? { unmaskedFreeText: unmaskedFreeText.sort() } : {}),
    },
    contactPoints: choices.contactPoints,
    degraded: degradedParts(annex),
    auditDates: 'new',
  };
  return {
    conversion: {
      dataset,
      summary,
      identityKeys: Object.fromEntries(
        choices.link.map((link) => [link.objectApiName, [...link.fields]]),
      ),
      linkedById,
      filesLeft: survey.filesLeft,
    },
  };
}

/** The parts of the annex a checkpoint lacks, whose records get the other org's defaults. */
function degradedParts(annex: CheckpointReplayAnnex | undefined): CheckpointReplayAnnexPart[] {
  if (annex === undefined) return ['recordTypes', 'users', 'queues', 'standardPricebook'];
  return [...new Set(annex.unread.map((each) => each.part))];
}

/** Two texts in the order of their code points. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ─── All three ───────────────────────────────────────────────────────────────

/** What {@link convertCheckpoint} is given: the source, and the other org as read. */
export type ReplayConvertInput = ReplaySource &
  Omit<ReplayTargetRead, 'source' | 'survey'> & {
    targetName: string;
    salt?: string;
  };

/** The survey, the other org's reads and the conversion, one after the other. */
export async function convertCheckpoint(
  input: ReplayConvertInput,
): Promise<
  | { conversion: ReplayConversion; target: ReplayTarget; survey: ReplaySurvey }
  | { refusal: ReplayOwnerMapRefusal; target: ReplayTarget; survey: ReplaySurvey }
> {
  const source: ReplaySource = {
    folder: input.folder,
    checkpoint: input.checkpoint,
    annex: input.annex,
    choices: input.choices,
  };
  const survey = await surveyCheckpoint(source);
  const target = await readReplayTarget({ ...input, source, survey });
  const converted = await checkpointToDataset({
    ...source,
    survey,
    target,
    targetName: input.targetName,
    ...(input.salt !== undefined ? { salt: input.salt } : {}),
  });
  return { ...converted, target, survey };
}
