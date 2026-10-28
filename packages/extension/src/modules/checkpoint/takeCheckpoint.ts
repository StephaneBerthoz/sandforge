/**
 * Taking a checkpoint of an org: what the org is and lets the user do, which
 * objects it holds and what reading them costs, the moment it is of, what was
 * in the recycle bin then, every record of every object as it is read, and
 * what moved while it was read.
 *
 * The order is the one a rewind depends on.
 *
 * - Nothing of the org is read before the guard has said it is no production
 *   org and its user sees and may put back every record; and no record before
 *   the org's lock is held, the scope is settled and its counts fit the limit
 *   and the requests the org has left today. A refusal names why, and leaves
 *   nothing behind.
 * - T0, the moment the checkpoint is of, is read on the org's clock before the
 *   records are counted. An object counted empty is then one read empty after
 *   T0, as any other object read after it is, and its snapshot is not asked
 *   for: on a Developer Edition org most objects are empty, and reading each
 *   one would cost a request apiece of a day's 15,000.
 * - The recycle bin at T0 is what it holds stamped before T0's second: the
 *   org drops a literal's milliseconds, and `< T` and `>= T` split its bin
 *   exactly. A record deleted after T0 cannot be among them, as its delete
 *   stamped it and a stamp never moves in the bin; one deleted in T0's own
 *   second before it is left out, and reads later as deleted while the
 *   checkpoint was taken: brought back, never lost.
 * - The snapshot reads children first, the order a removal deletes them in: a
 *   row it holds then names only parents that still existed when they were
 *   read after it. It is read by a DataOps handler of its own, bound to the
 *   checkpoint's folder, which holds every row of an object or keeps nothing:
 *   a checkpoint holding part of an object would have its rewind delete the
 *   rest as created since. Its pages are put down compressed as they come,
 *   never plain first. Each object's index is written from its file once
 *   read, and must hold as many rows as the read kept.
 * - T1 follows every read. What moved between T0 and T1 after its object was
 *   read is counted, the warning the take ends with: each record is held as it
 *   was read, and a rewind treats what moved since as changed since.
 * - Every request the take sends the org is counted, phase by phase, the
 *   snapshot's own connection's and the SOAP calls among them, and said beside
 *   what the take estimated before it read a record. The org's own count of
 *   its day trails the calls by a minute or two and takes in every call made
 *   to it meanwhile: only the take's count tells which of its reads an
 *   estimate prices short.
 *
 * A take that is stopped or fails keeps nothing: its folder goes, and the
 * records' values with it. One that never ends — its process killed — leaves
 * a checkpoint listed as being taken, which can only be deleted.
 */

import { readdir, rm, stat } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { Connection } from 'jsforce';
import * as z from 'zod';
import {
  checkpointIgnoredFieldsSchema,
  checkpointNameSchema,
  sanitizeSoqlObjectName,
  type CheckpointEstimate,
  type CheckpointLeftOutObject,
  type CheckpointObject,
  type CheckpointRefusal,
  type CheckpointScopeMode,
  type CheckpointScopeObject,
  type CheckpointTakePhase,
  type CheckpointTakeRequests,
  type OrgCheckpoint,
  type OrgTypeAndEdition,
} from '@sandforge/shared';
import { DataOpsHandler } from '../../bridge/handlers/DataOpsHandler.js';
import type { HandlerDeps } from '../../bridge/handlers/HandlerTypes.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { getQueryLimits, resolveOrgTier } from '../../core/common/queryLimits.js';
import { countRequests, type TypedTarget } from '../../core/precheck/orgKindLive.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import type { ConfigEntry } from '../../core/storage/ConfigStoreBackend.js';
import { StepCancelledError } from '../automation/StepExecutor.js';
import {
  BackupRecordStore,
  nodeBackupFiles,
  type BackupRecordStoreDeps,
} from '../dataops/BackupRecordStore.js';
import type { ApiBudget } from '../forge/ForgeRunGate.js';
import { orgDateTime } from '../sync/SyncDelta.js';
import { viewsEncryptedData } from '../sync/encryptedFields.js';
import {
  CheckpointStoreError,
  DEFAULT_KEEP_DAYS,
  binFileOf,
  compressedFieldPrints,
  expiresAtFor,
  makePrivateDir,
  newFolderId,
  type CheckpointFolder,
  type OrgCheckpointStore,
  type OrgLockHolder,
} from './OrgCheckpointStore.js';
import {
  checkpointDescribeSchema,
  objectCapture,
  type CheckpointDescribe,
  type ObjectCapture,
} from './checkpointFields.js';
import { fingerprintOf, type ObjectFingerprint } from './checkpointFingerprint.js';
import { guardCheckpoint } from './checkpointGuard.js';
import { compressedSnapshotFiles } from './compressedSnapshotFiles.js';
import {
  globalObjectSchema,
  resolveScope,
  scopeCandidates,
  withoutRefusedReads,
  type GlobalObject,
  type ScopeLeftOut,
  type ScopeLeftOutReason,
  type ScopedObject,
} from './checkpointScope.js';
import {
  OrgReadStopped,
  compositeConnectionOf,
  compositeReader,
  type CompositeQueryConnection,
  type CompositeReader,
} from './compositeQueries.js';
import {
  binLedgerRead,
  countRead,
  countRecords,
  readChanges,
  soqlInstant,
  spoolReads,
  spooledRows,
  type ObjectChanges,
} from './orgStreams.js';
import {
  budgetRefusal,
  readBudget,
  snapshotGroupReads,
  takeEstimate,
  type TakenObject,
} from './rewindEstimate.js';
import { SnapshotIndex, snapshotFileOf, writeSnapshotIndex } from './snapshotIndex.js';

// ─── Limits and figures ──────────────────────────────────────────────────────

/** The records a take holds at most, all objects together, unless it is given another limit. */
export const DEFAULT_MAX_TOTAL = 500_000;

/**
 * The most rows a snapshot reads of one object: the bound DataOps holds
 * `sandforge.backup.maxRecordsPerObject` to. An object past it, or past the
 * take's own limit, is left out before reading, never read in part.
 */
const OBJECT_ROWS_MAX = 1_000_000;

/** The least that setting takes: a limit under it still reads that many rows of an object. */
const SNAPSHOT_CAP_MIN = 100;

/** What a checkpoint's folder holds while its take checks what moved: removed before it ends. */
const STABILITY_DIR = 'taking';

/** The most characters a left-out object's reason holds in the checkpoint's file. */
const REASON_MAX = 500;

// ─── What the take reads the org through ─────────────────────────────────────

/**
 * What a take reads an org through, beside the connection its snapshot's own
 * handler opens: queries and describes, alone or in composites; the global
 * describe; the org's clock; and the user it reads as.
 */
export interface TakeOrg extends CompositeQueryConnection {
  describeGlobal(): Promise<unknown>;
  /**
   * The objects the org's Tooling API serves, which are metadata: none when
   * it cannot say. Absent, none.
   */
  toolingObjects?(): Promise<string[]>;
  /** The org's clock now, as it dates what it writes (SOAP `getServerTimestamp`). */
  serverTime(): Promise<string>;
  /** The id of the user the connection reads as (SOAP `getUserInfo`). */
  userId(): Promise<string>;
  /**
   * The requests sent the org so far through this connection and through each
   * one handed to {@link countAlso}, SOAP calls among them: each is one of the
   * org's daily requests. Absent, the take does not say what it sent.
   */
  requestsSent?(): number;
  /**
   * Count among {@link requestsSent} what `connection` sends the org from now
   * on: the connection the snapshot's own handler reads through.
   */
  countAlso?(connection: Connection): void;
}

/**
 * A jsforce connection, as a take reads the org through it. Every request it
 * sends is counted from here on, and those of the connections handed to
 * `countAlso`.
 */
export function takeOrgOf(conn: Connection): TakeOrg {
  const composite = compositeConnectionOf(conn);
  const counts = [countRequests(conn)];
  return {
    get version() {
      return conn.version;
    },
    request: (request) => composite.request(request),
    query: (soql, options) => composite.query(soql, options),
    queryMore: (nextRecordsUrl) => composite.queryMore(nextRecordsUrl),
    describeGlobal: async () => await conn.describeGlobal(),
    toolingObjects: async () => {
      try {
        const answer = await conn.tooling.describeGlobal();
        return answer.sobjects.map((sobject) => sobject.name);
      } catch {
        return [];
      }
    },
    serverTime: async () => (await conn.soap.getServerTimestamp()).timestamp,
    userId: async () => (await conn.soap.getUserInfo()).userId,
    requestsSent: () => counts.reduce((total, count) => total + count(), 0),
    countAlso: (connection) => {
      counts.push(countRequests(connection));
    },
  };
}

// ─── What a take is asked, and what it answers ───────────────────────────────

/** What a take, or its scope alone, is asked. */
export interface TakeRequest {
  /** The org's id in the registry: what the snapshot's own handler connects through. */
  orgId: string;
  /** How the user knows the org: its alias, else its username. */
  orgName: string;
  alias?: string;
  /** The user SandForge connects as. */
  username: string;
  instanceUrl: string;
  /** The org as the registry holds it; undefined when it holds none, which the guard refuses. */
  registered: OrgTypeAndEdition | undefined;
  /** When the scratch org expires, as the registry knows it. */
  scratchExpiresAt?: string;
  mode: CheckpointScopeMode;
  /** The objects picked, in `picked` mode. */
  objects?: readonly string[];
  /** Objects to leave out, in either mode. */
  excluded?: readonly string[];
  /** What it is called; the date and time of T0 by default. */
  name?: string;
  /** Days until it expires; 0 keeps it until it is deleted. */
  keepDays?: number;
  /** Fields, `Object.Field`, neither compared nor written back. */
  ignoredFields?: readonly string[];
  /** The records it holds at most, all objects together: {@link DEFAULT_MAX_TOTAL} unless given. */
  maxTotal?: number;
}

/** How far a take is. */
export interface TakeProgress {
  percentage: number;
  /** Objects read so far, of {@link totalObjects}. */
  processedObjects: number;
  totalObjects: number;
  step: string;
}

/** What a take works with. */
export interface TakeDeps {
  org: TakeOrg;
  store: OrgCheckpointStore;
  /** What the snapshot's own DataOps handler is built from: the host's log, its orgs and their credentials. */
  handler: Pick<HandlerDeps, 'log' | 'orgManager' | 'orgRegistry'>;
  /** Stops the take between two reads: nothing is kept. */
  signal?: AbortSignal;
  onProgress?: (progress: TakeProgress) => void;
  /**
   * What else of this machine is writing to the org, said as a refusal names
   * it — a SandForge run of this window, a run file written elsewhere — or
   * nothing. Asked once the org's lock is held, before anything is read.
   */
  runWriting?: (organizationId: string) => Promise<string | undefined> | string | undefined;
  /** This machine's clock: the checkpoint's id and its expiry. */
  now?: () => Date;
  /**
   * The files the snapshot's values are written through, over the
   * checkpoint's folder: compressed as each page comes
   * ({@link compressedSnapshotFiles}) unless another is given — the plain
   * files of a backup, as SandForge 1.69 and earlier wrote a snapshot, which
   * every reader of a checkpoint still reads.
   */
  snapshotFiles?: (dir: string) => BackupRecordStoreDeps;
}

/** The files a take writes its snapshot through when it is given none: compressed. */
function compressedFilesOf(dir: string): BackupRecordStoreDeps {
  return compressedSnapshotFiles(nodeBackupFiles(dir));
}

/** An object the take could not check for what moved while it was read, and why. */
export interface NotChecked {
  objectApiName: string;
  reason: string;
}

/** How a take ended, when it was not stopped and did not fail. */
export type TakeOutcome =
  | {
      taken: true;
      checkpoint: OrgCheckpoint;
      /**
       * Objects whose read of what moved while the take ran failed: the
       * checkpoint holds them whole, and what moved there is not counted.
       */
      notChecked: NotChecked[];
      /**
       * The requests the take sent the org, phase by phase, as its org
       * counted them; absent when the org does not count them.
       */
      requests?: CheckpointTakeRequests;
      /** What the take estimated, phase by phase, before it read a record. */
      estimate: CheckpointEstimate;
    }
  | { taken: false; refusal: CheckpointRefusal };

/** What a take would hold and cost, read from the org's describes and counts: nothing kept. */
export interface TakeScope {
  mode: CheckpointScopeMode;
  objects: CheckpointScopeObject[];
  leftOut: CheckpointLeftOutObject[];
  estimate: CheckpointEstimate;
  /** The refusal a take would meet before reading a record, when it would meet one. */
  refusal?: CheckpointRefusal;
}

/** Why a take ended without a checkpoint: it was stopped. Nothing of it is kept. */
export class CheckpointTakeStopped extends Error {
  constructor() {
    super('The checkpoint was stopped before it was taken: nothing of it was kept.');
    this.name = 'CheckpointTakeStopped';
  }
}

// ─── Words ───────────────────────────────────────────────────────────────────

/** What a take did not do, as each refusal ends. */
const NOTHING_READ = 'No record was read.';

/** Why the scope left an object out, as a person reads it. */
const LEFT_OUT_WORDS: Readonly<Record<ScopeLeftOutReason, string>> = {
  excludedByUser: 'Left out as asked.',
  notFound: 'The org has no object of this name.',
  chatter:
    'Chatter posts, comments and feeds are left out: Salesforce brings a post back only with ' +
    'what it was posted on.',
  history: "History is left out: it is the org's own trace of changes.",
  sharing: 'Sharing is left out: the org keeps it itself.',
  changeEvent: 'Change events are left out.',
  unsupportedKind:
    'Left out: neither the recycle bin nor an update reaches this kind of object as it ' +
    'reaches a record.',
  customSetting: 'Custom settings are left out: they are configuration.',
  files: "Files are left out: a checkpoint doesn't cover files.",
  setup: 'Users, permissions and setup are left out.',
  metadata: "Left out: it is metadata, which a checkpoint doesn't hold.",
  notWritable:
    'Left out: the user SandForge connects as may not create, edit and delete its records.',
  notDescribed: 'Left out: the org would not describe it.',
  noSystemModstamp:
    'Left out: it has no SystemModstamp, so nothing would tell a record changed since.',
  noRecycleBin:
    'Left out: the org deletes its records for good, with no recycle bin, so nothing would ' +
    'tell one deleted since, nor bring it back.',
  unreadable: 'Left out: the org refuses to read it whole.',
};

/** An object the scope left out, as the checkpoint's file and the take's answer name it. */
function leftOutOf(out: ScopeLeftOut): CheckpointLeftOutObject {
  const words = LEFT_OUT_WORDS[out.reason];
  const reason = out.detail === undefined ? words : `${words.replace(/\.$/, '')} (${out.detail}).`;
  return { objectApiName: out.objectApiName, reason: clipped(reason) };
}

/** An object left out for its size, as a person reads it. */
function pastTheLimit(
  objectApiName: string,
  records: number,
  limit: number,
): CheckpointLeftOutObject {
  return {
    objectApiName,
    reason:
      `${objectApiName} has ${records} records, past the checkpoint's limit of ${limit} for ` +
      'one object: left out of the checkpoint, as part of it would be taken for all of it.',
  };
}

function clipped(text: string): string {
  return text.length <= REASON_MAX ? text : `${text.slice(0, REASON_MAX - 1)}…`;
}

/** The refusal of a take while another one, a rewind or an undo of the org holds its lock. */
function lockedRefusal(orgName: string, holder: OrgLockHolder): CheckpointRefusal {
  const what =
    holder.operation === 'take'
      ? `A checkpoint of ${orgName} is being taken`
      : holder.operation === 'rewind'
        ? `A rewind is writing to ${orgName}`
        : holder.operation === 'undo'
          ? `An undo is writing to ${orgName}`
          : `SandForge is deleting checkpoints of ${orgName}`;
  return {
    code: 'RUN_WRITING',
    message: `${what} (process ${holder.pid} on ${holder.host}): take the checkpoint once it has ended. ${NOTHING_READ}`,
  };
}

// ─── Reading the scope ───────────────────────────────────────────────────────

/** The org's answer to a call it refused, in its words; undefined for a call that never reached it. */
function orgRefusal(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { errorCode?: unknown }).errorCode;
  return typeof code === 'string' ? extractErrorMessage(err) : undefined;
}

/** A stop, from whichever read saw it, as the take says it. */
function stopped(err: unknown, signal: AbortSignal | undefined): boolean {
  return (
    err instanceof OrgReadStopped ||
    err instanceof StepCancelledError ||
    err instanceof CheckpointTakeStopped ||
    signal?.aborted === true
  );
}

const globalDescribeSchema = z.object({ sobjects: z.array(globalObjectSchema) }).loose();

/** One object of the scope, described, as the take keeps it. */
interface Described {
  scoped: ScopedObject;
  label: string;
  describe: CheckpointDescribe;
  capture: ObjectCapture;
}

/** The scope read from the org's describes: what a take would hold, before any count. */
interface DescribedScope {
  /** Objects described. */
  described: number;
  /** Of them, those whose describe was asked again alone. */
  describedAlone: number;
  objects: Described[];
  leftOut: ScopeLeftOut[];
}

/**
 * Describe `names`, 25 a composite. One the composite did not answer is asked
 * again alone: the org's refusal leaves it out in its words, and any other
 * failure fails the take — an object a dropped call left out would be one a
 * rewind never puts back, and nothing would say so.
 *
 * @returns The describes, the org's refusals, and how many were asked alone:
 *   a request each beside the composites, which the estimate counts.
 */
async function describeAll(
  org: TakeOrg,
  reader: CompositeReader,
  names: readonly string[],
): Promise<{
  describes: Map<string, CheckpointDescribe>;
  errors: Map<string, string>;
  alone: number;
}> {
  const describes = new Map<string, CheckpointDescribe>();
  const errors = new Map<string, string>();
  let alone = 0;
  const answers = await Promise.allSettled(names.map((name) => reader.describe(name)));
  for (const [at, answer] of answers.entries()) {
    const name = names[at];
    let body: unknown;
    if (answer.status === 'fulfilled' && 'body' in answer.value) {
      body = answer.value.body;
    } else if (answer.status === 'rejected' && answer.reason instanceof OrgReadStopped) {
      throw answer.reason;
    } else {
      alone++;
      try {
        body = await org.request({
          method: 'GET',
          url: `/services/data/v${org.version}/sobjects/${sanitizeSoqlObjectName(name)}/describe`,
        });
      } catch (err: unknown) {
        const refusal = orgRefusal(err);
        if (refusal === undefined) {
          throw new Error(
            `The org did not answer the describe of ${name}: ${extractErrorMessage(err)}`,
          );
        }
        errors.set(name, refusal);
        continue;
      }
    }
    const parsed = checkpointDescribeSchema.safeParse(body);
    if (parsed.success) describes.set(name, parsed.data);
    else errors.set(name, 'its describe does not read as one');
  }
  return { describes, errors, alone };
}

/** The objects a take would hold, described, with the ones left out, from the org's describes. */
async function describeScope(
  org: TakeOrg,
  reader: CompositeReader,
  request: TakeRequest,
): Promise<DescribedScope> {
  const global = globalDescribeSchema.parse(await org.describeGlobal());
  const tooling = (await org.toolingObjects?.()) ?? [];
  const candidates = scopeCandidates(
    global.sobjects,
    {
      mode: request.mode,
      ...(request.objects ? { objects: request.objects } : {}),
      ...(request.excluded ? { excluded: request.excluded } : {}),
    },
    tooling,
  );
  const { describes, errors, alone } = await describeAll(org, reader, candidates.candidates);
  const scope = resolveScope(candidates, describes, errors);
  const encrypted = await viewsEncryptedData(async (soql) => (await org.query(soql)).records);
  const labels = new Map(
    global.sobjects.map((object: GlobalObject) => [object.name, labelOf(object)]),
  );
  const all = [...describes.values()];
  const objects: Described[] = [];
  for (const scoped of scope.objects) {
    const describe = describes.get(scoped.objectApiName);
    if (!describe) continue;
    objects.push({
      scoped,
      label: labels.get(scoped.objectApiName) ?? scoped.objectApiName,
      describe,
      capture: await objectCapture(describe, all, { viewsEncryptedData: encrypted }),
    });
  }
  return {
    described: candidates.candidates.length,
    describedAlone: alone,
    objects,
    leftOut: scope.leftOut,
  };
}

function labelOf(object: GlobalObject): string {
  const label: unknown = object.label;
  return typeof label === 'string' && label !== '' ? label : object.name;
}

/**
 * The records of each of `objects`, five counts a composite. A count the
 * composite did not answer is asked again alone: the org's refusal of an
 * unfiltered read leaves the object out in its words, and never fails the
 * take; any other failure does.
 *
 * @returns The counts, the org's refusals, and how many were asked alone: a
 *   request each beside the composites, which the estimate counts.
 */
async function countAll(
  org: TakeOrg,
  reader: CompositeReader,
  objects: readonly Described[],
  signal: AbortSignal | undefined,
): Promise<{ counts: Map<string, number>; refused: Map<string, string>; alone: number }> {
  const answers = await countRecords(
    reader,
    objects.map(({ capture }) => ({
      objectApiName: capture.objectApiName,
      readMode: capture.readMode,
    })),
    signal,
  );
  const counts = new Map<string, number>();
  const refused = new Map<string, string>();
  let alone = 0;
  for (const [at, answer] of answers.entries()) {
    const { objectApiName, readMode } = objects[at].capture;
    if ('count' in answer) {
      counts.set(objectApiName, answer.count);
      continue;
    }
    alone++;
    const read = countRead(objectApiName, readMode);
    try {
      const page = await org.query(read.soql, { scanAll: read.scanAll });
      if (typeof page.totalSize !== 'number') {
        throw new Error('The org gave no count of its records.');
      }
      counts.set(objectApiName, page.totalSize);
    } catch (err: unknown) {
      const refusal = orgRefusal(err);
      if (refusal === undefined) {
        throw new Error(
          `The org did not count the records of ${objectApiName}: ${extractErrorMessage(err)}`,
        );
      }
      refused.set(objectApiName, refusal);
    }
  }
  return { counts, refused, alone };
}

/** One object a take holds, with what it records of it before reading it. */
interface Planned extends Described {
  records: number;
  /** For each of its column groups after the first, the ids a read of it by id names a statement. */
  otherGroups: number[];
}

/**
 * What `checkpoint.json` says of an object of the plan: as the take writes
 * it once it ran, and as its estimate counts its bytes before, with the
 * counts and the print it has then.
 */
function entryOf(
  { scoped, capture }: Pick<Planned, 'scoped' | 'capture'>,
  records: number,
  inBin: number,
  fingerprint: string,
): CheckpointObject {
  return {
    objectApiName: scoped.objectApiName,
    records,
    inBin,
    readOrder: scoped.readOrder,
    readMode: capture.readMode,
    undeletable: capture.undeletable,
    cascadeParents: capture.cascadeParents,
    restrictParents: capture.restrictParents,
    fingerprint,
    fields: capture.fields,
    leftOutFields: capture.leftOutFields,
  };
}

/** What a take would hold and cost, settled before any record is read. */
interface Plan {
  objects: Planned[];
  leftOut: CheckpointLeftOutObject[];
  estimate: CheckpointEstimate;
  /** The most rows the snapshot reads of one object. */
  objectLimit: number;
  /** Each object's field prints, by object, from its describe: what the take keeps of them. */
  prints: Record<string, ObjectFingerprint>;
  /** The refusal the gates give, when they give one. */
  refusal?: CheckpointRefusal;
}

/** The rows a page of the snapshot reads, as its handler reads the org's kind. */
function pageRowsOf(registered: OrgTypeAndEdition | undefined): number {
  const developmentTier = registered?.orgType === 'Sandbox' || registered?.orgType === 'Scratch';
  return getQueryLimits(resolveOrgTier(developmentTier)).defaultQueryLimit;
}

/**
 * The scope counted and held to the take's limits: objects the org will not
 * read whole and objects past the limit for one object left out, named; the
 * rest refused past the take's limit or past the requests the org has left
 * today.
 */
async function planOf(
  org: TakeOrg,
  reader: CompositeReader,
  request: TakeRequest,
  scope: DescribedScope,
  budget: ApiBudget,
  signal: AbortSignal | undefined,
): Promise<Plan> {
  const maxTotal = request.maxTotal ?? DEFAULT_MAX_TOTAL;
  if (!Number.isInteger(maxTotal) || maxTotal < 1) {
    throw new RangeError(`Not a number of records: ${maxTotal}`);
  }
  const objectLimit = Math.min(maxTotal, OBJECT_ROWS_MAX);
  const { counts, refused, alone } = await countAll(org, reader, scope.objects, signal);
  const readable = withoutRefusedReads(
    {
      mode: request.mode,
      objects: scope.objects.map(({ scoped }) => scoped),
      leftOut: scope.leftOut,
      packages: [],
    },
    refused,
  );
  const byName = new Map(scope.objects.map((object) => [object.scoped.objectApiName, object]));
  const leftOut = readable.leftOut.map(leftOutOf);
  const objects: Planned[] = [];
  for (const scoped of readable.objects) {
    const object = byName.get(scoped.objectApiName);
    const records = counts.get(scoped.objectApiName);
    if (object === undefined || records === undefined) continue;
    if (records > objectLimit) {
      leftOut.push(pastTheLimit(scoped.objectApiName, records, objectLimit));
      continue;
    }
    objects.push({
      ...object,
      scoped: { ...scoped, readOrder: objects.length },
      records,
      otherGroups: snapshotGroupReads(
        scoped.objectApiName,
        object.capture.fields,
        object.capture.readMode,
      ),
    });
  }
  leftOut.sort((a, b) =>
    a.objectApiName < b.objectApiName ? -1 : a.objectApiName > b.objectApiName ? 1 : 0,
  );
  // Made from the describes already read: the take writes these very prints.
  const prints: Record<string, ObjectFingerprint> = {};
  for (const { scoped, describe } of objects) {
    prints[scoped.objectApiName] = fingerprintOf(describe.fields);
  }
  const cost = takeEstimate({
    described: scope.described,
    describedAlone: scope.describedAlone,
    counted: scope.objects.length,
    countedAlone: alone,
    objects: objects.map((object): TakenObject => ({
      records: object.records,
      otherGroups: object.otherGroups,
      // None in the bin yet: the take reads it after the estimate.
      entry: entryOf(object, object.records, 0, prints[object.scoped.objectApiName].digest),
    })),
    pageRows: pageRowsOf(request.registered),
    leftOut,
    printsBytes: (await compressedFieldPrints(prints)).length,
  });
  const estimate: CheckpointEstimate = { ...cost, apiRequestsLeft: budget.remaining };
  const plan: Plan = { objects, leftOut, estimate, objectLimit, prints };
  if (cost.records > maxTotal) {
    return {
      ...plan,
      refusal: {
        code: 'TOO_MANY_RECORDS',
        message:
          `The objects this checkpoint would keep hold ${cost.records} records in ` +
          `${request.orgName}, past its limit of ${maxTotal}: pick fewer objects, or raise the ` +
          `limit. ${NOTHING_READ}`,
      },
    };
  }
  const overBudget = budgetRefusal('take', cost.apiRequests, budget, request.orgName);
  return overBudget === undefined ? plan : { ...plan, refusal: overBudget };
}

/** {@link guardCheckpoint}'s view of the take's org: it reads the answer's records, nothing else of jsforce's query. */
function guardConnectionOf(org: TakeOrg): Pick<Connection, 'query'> {
  return { query: (soql: string) => org.query(soql) } as unknown as Pick<Connection, 'query'>;
}

/** The scope's objects as the take's answer lists them, before anything is read. */
function scopeObjectsOf(plan: Plan): CheckpointScopeObject[] {
  return plan.objects.map(({ scoped, label, capture, records }) => ({
    objectApiName: scoped.objectApiName,
    label,
    ...(scoped.namespace !== undefined ? { namespace: scoped.namespace } : {}),
    records,
    undeletable: capture.undeletable,
    leftOutFields: capture.leftOutFields,
  }));
}

/** An estimate of nothing: a take refused before its scope was read. */
const NO_ESTIMATE: CheckpointEstimate = {
  records: 0,
  apiRequests: 0,
  apiRequestsLeft: 0,
  seconds: 0,
  bytes: 0,
};

/**
 * What a take of the org would hold and cost, and the refusal it would meet
 * before reading a record, read from its describes and counts: no record is
 * read, nothing is kept. The guard is asked first, and an org it refuses is
 * not read at all.
 */
export async function scopeCheckpoint(deps: TakeDeps, request: TakeRequest): Promise<TakeScope> {
  const empty = { mode: request.mode, objects: [], leftOut: [], estimate: NO_ESTIMATE };
  const guard = await guardCheckpoint(guardConnectionOf(deps.org), {
    act: 'take',
    orgName: request.orgName,
    registered: request.registered,
    username: request.username,
  });
  if (!guard.allowed) return { ...empty, refusal: guard.refusal };
  const holder = deps.store.heldBy(guard.org.id);
  const writing = holder === undefined ? await deps.runWriting?.(guard.org.id) : undefined;
  const reader = compositeReader(deps.org, deps.signal);
  try {
    const budget = await readBudget(deps.org, request.orgName);
    const scope = await describeScope(deps.org, reader, request);
    const plan = await planOf(deps.org, reader, request, scope, budget, deps.signal);
    const answer: TakeScope = {
      mode: request.mode,
      objects: scopeObjectsOf(plan),
      leftOut: plan.leftOut,
      estimate: plan.estimate,
    };
    const refusal =
      holder !== undefined
        ? lockedRefusal(request.orgName, holder)
        : writing !== undefined
          ? { code: 'RUN_WRITING' as const, message: writing }
          : plan.refusal;
    return refusal === undefined ? answer : { ...answer, refusal };
  } catch (err: unknown) {
    if (stopped(err, deps.signal)) throw new CheckpointTakeStopped();
    throw err;
  }
}

// ─── What the take sends ─────────────────────────────────────────────────────

/** The requests a take sends, phase by phase, as its org counts them. */
interface PhaseCount {
  /** Count from now on in `phase`: what was sent since the last phase began is that one's. */
  enter(phase: CheckpointTakePhase): void;
  /** What was sent so far, phase by phase; undefined when the org does not count. */
  requests(): CheckpointTakeRequests | undefined;
}

/** A count of what the take sends `org`, in its first phase, the guard's. */
function phaseCount(org: TakeOrg): PhaseCount {
  const sent = org.requestsSent ? (): number => org.requestsSent?.() ?? 0 : undefined;
  const byPhase: Record<CheckpointTakePhase, number> = {
    guard: 0,
    scope: 0,
    start: 0,
    counts: 0,
    bin: 0,
    snapshot: 0,
    stability: 0,
  };
  let phase: CheckpointTakePhase = 'guard';
  let at = sent?.() ?? 0;
  const settle = (): void => {
    if (!sent) return;
    const now = sent();
    byPhase[phase] += now - at;
    at = now;
  };
  return {
    enter(next) {
      settle();
      phase = next;
    },
    requests() {
      if (!sent) return undefined;
      settle();
      const total = Object.values(byPhase).reduce((sum, requests) => sum + requests, 0);
      return { total, byPhase: { ...byPhase } };
    },
  };
}

// ─── The take ────────────────────────────────────────────────────────────────

/** The org's edition, as `Organization.OrganizationType` gives it: the guard reads it of an org that is not a sandbox only. */
async function editionOf(org: TakeOrg, typed: TypedTarget): Promise<string> {
  if (typed.edition !== undefined) return typed.edition;
  const answer = await org.query('SELECT OrganizationType FROM Organization LIMIT 1');
  const edition = answer.records[0]?.OrganizationType;
  if (typeof edition !== 'string' || edition === '') {
    throw new Error('The org did not say its edition (Organization.OrganizationType).');
  }
  return edition;
}

/** The org's Automated Process user, whose writes in answer to a rewind are the rewind's own; none when it has none. */
async function automatedProcessUserOf(org: TakeOrg): Promise<string | undefined> {
  const answer = await org.query("SELECT Id FROM User WHERE UserType = 'AutomatedProcess' LIMIT 1");
  const id = answer.records[0]?.Id;
  return typeof id === 'string' ? id : undefined;
}

/** A name of T0 as a person reads it, for a checkpoint not given one: `2026-10-22 14:05 UTC`. */
function defaultNameOf(readFrom: string): string {
  const at = new Date(Date.parse(readFrom)).toISOString();
  return `${at.slice(0, 10)} ${at.slice(11, 16)} UTC`;
}

/** A stamp as the org gives it, in milliseconds; NaN for anything else. */
function stampMs(value: unknown): number {
  const at = orgDateTime(value);
  return at === null ? Number.NaN : Date.parse(at);
}

/** The key the org knows a record by: its id's first fifteen characters. */
function keyOf(id: unknown): string | undefined {
  return typeof id === 'string' && id.length >= 15 ? id.slice(0, 15) : undefined;
}

/** The ids an object had in the recycle bin at T0, by key, from its bin file. */
async function binKeysOf(folder: CheckpointFolder, objectApiName: string): Promise<Set<string>> {
  const keys = new Set<string>();
  for await (const row of spooledRows(binFileOf(folder, objectApiName))) {
    const key = keyOf(row.Id);
    if (key !== undefined) keys.add(key);
  }
  return keys;
}

/** Counts of what moved while a take read, after its object was read. */
interface Moved {
  changed: number;
  deleted: number;
  created: number;
}

/**
 * What of one object moved between its read and T1, from the reads of what
 * moved since T0: a record the snapshot holds stamped otherwise since is
 * changed; a live record it does not hold appeared after its object was
 * read; a record deleted since that it holds, or that was live at T0 — dated
 * before T0's second, and not in the bin then — was deleted while the take
 * ran. What was made and deleted while it ran leaves nothing to count, and
 * what moved after T1 is a change since the checkpoint, not while it was
 * taken.
 */
async function movedOf(
  folder: CheckpointFolder,
  snapshotId: string,
  objectApiName: string,
  changes: Extract<ObjectChanges, { moved: boolean }>,
  t0s: number,
  t1: number,
): Promise<Moved> {
  const moved: Moved = { changed: 0, deleted: 0, created: 0 };
  if (!changes.live && !changes.deleted) return moved;
  const index = await SnapshotIndex.read(folder, snapshotId, objectApiName);
  if (changes.live) {
    for await (const row of spooledRows(changes.live.file)) {
      const stamp = stampMs(row.SystemModstamp);
      if (!(stamp <= t1)) continue;
      const held = index.stampOf(row.Id);
      if (held === undefined) moved.created++;
      else if (held !== stamp) moved.changed++;
    }
  }
  if (changes.deleted) {
    let bin: Set<string> | undefined;
    for await (const row of spooledRows(changes.deleted.file)) {
      if (!(stampMs(row.SystemModstamp) <= t1)) continue;
      if (index.has(row.Id)) {
        moved.deleted++;
        continue;
      }
      if (!(stampMs(row.CreatedDate) < t0s)) continue;
      bin ??= await binKeysOf(folder, objectApiName);
      const key = keyOf(row.Id);
      if (key !== undefined && !bin.has(key)) moved.deleted++;
    }
  }
  return moved;
}

/** Bytes the files under `dir` take. */
async function bytesUnder(dir: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) bytes += await bytesUnder(path);
    else if (entry.isFile()) bytes += (await stat(path)).size;
  }
  return bytes;
}

/**
 * Bytes a checkpoint's folder takes once `checkpoint` is its file: every
 * other file as it is, its own as the store writes it. Measured before, the
 * folder held the file of the take under way, which lists no object: on an
 * org of 200 objects, a sixth of the checkpoint went uncounted. The count is
 * written into the file it counts, so it is counted with its own digits.
 */
async function bytesKept(folder: CheckpointFolder, checkpoint: OrgCheckpoint): Promise<number> {
  const others = (await bytesUnder(folder.dir)) - (await stat(folder.checkpointFile)).size;
  const fileWith = (bytes: number): number =>
    Buffer.byteLength(`${JSON.stringify({ ...checkpoint, bytes }, null, 2)}\n`, 'utf8');
  let bytes = others + fileWith(others);
  bytes = others + fileWith(bytes);
  return bytes;
}

/**
 * The product's config store, kept in the checkpoint's `snapshots.json`: the
 * snapshot's DataOps metadata, as the command lines keep a store of their
 * own. Its owner's alone to read.
 */
function snapshotsStoreOf(folder: CheckpointFolder): ConfigStore {
  const file = folder.snapshotsFile;
  const store = new ConfigStore({
    getData: () =>
      existsSync(file)
        ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, ConfigEntry>)
        : {},
    setData: (data) =>
      writeFileSync(file, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 }),
  });
  store.initialize();
  return store;
}

/** What the snapshot's metadata says of the org it was read from. */
const snapshotMetaSchema = z.object({ organizationId: z.string().optional() }).loose();

/**
 * A DataOps handler of the checkpoint's own: its snapshot's metadata in the
 * checkpoint's `snapshots.json`, its files in the checkpoint's `backups/`,
 * written through `files`, no entry of its own in the registry nor in Live
 * Operations — the take's are the checkpoint's — and its progress passed on
 * to the take. It reads at most `cap` rows of an object, and the take never
 * asks it for an object past it.
 *
 * Built over the few dependencies a snapshot reads: the log, the org and its
 * credentials, the config store, the setting of the cap, the broker its
 * progress goes through, and message ids.
 */
async function snapshotHandlerOf(
  folder: CheckpointFolder,
  files: BackupRecordStoreDeps,
  deps: TakeDeps,
  cap: number,
  progress: (percentage: number, step: string) => void,
): Promise<{ handler: DataOpsHandler; config: ConfigStore }> {
  const config = snapshotsStoreOf(folder);
  let sent = 0;
  const handlerDeps = {
    log: deps.handler.log,
    orgManager: deps.handler.orgManager,
    orgRegistry: deps.handler.orgRegistry,
    configStore: config,
    broker: {
      postToWebview: (message: { type?: unknown; payload?: unknown }) => {
        if (message.type !== 'operation:progress') return;
        const payload = message.payload as { percentage?: unknown; currentStep?: unknown };
        if (typeof payload.percentage === 'number' && typeof payload.currentStep === 'string') {
          progress(payload.percentage, payload.currentStep);
        }
      },
    },
    services: {
      getSandforgeSetting: <T>(key: string, fallback: T): T =>
        key === 'backup.maxRecordsPerObject' ? (cap as T) : fallback,
    },
    nextId: () => `${folder.checkpointId}-${++sent}`,
  };
  const handler = new DataOpsHandler(handlerDeps as unknown as HandlerDeps);
  handler.setBackupRecordStore(new BackupRecordStore(files));
  await handler.swept();
  return { handler, config };
}

/** Whether two Organization Ids name one org: the 15-character id and its 18-character form alike. */
function sameOrganization(a: string, b: string): boolean {
  return a.slice(0, 15) === b.slice(0, 15);
}

/**
 * Take a checkpoint of the org: see the module's comment.
 *
 * @returns The checkpoint, kept; or the refusal a guard or a gate gave
 *   before any record was read, with nothing kept.
 * @throws {CheckpointTakeStopped} When the take was stopped: nothing is kept.
 * @throws When it failed: nothing is kept, and the error says why.
 */
export async function takeCheckpoint(deps: TakeDeps, request: TakeRequest): Promise<TakeOutcome> {
  const { org, store, signal } = deps;
  const now = deps.now ?? (() => new Date());
  // What the request names is checked before the org is asked anything.
  const ignoredFields = checkpointIgnoredFieldsSchema.parse([...(request.ignoredFields ?? [])]);
  const named = request.name === undefined ? undefined : checkpointNameSchema.parse(request.name);
  for (const objectApiName of [...(request.objects ?? []), ...(request.excluded ?? [])]) {
    sanitizeSoqlObjectName(objectApiName);
  }
  const keepDays = request.keepDays ?? DEFAULT_KEEP_DAYS;
  expiresAtFor(now(), keepDays);
  const report = (percentage: number, step: string, processed = 0, total = 0): void =>
    deps.onProgress?.({
      percentage: Math.round(percentage),
      processedObjects: processed,
      totalObjects: total,
      step,
    });

  report(0, `Checking ${request.orgName}`);
  const count = phaseCount(org);
  const guard = await guardCheckpoint(guardConnectionOf(org), {
    act: 'take',
    orgName: request.orgName,
    registered: request.registered,
    username: request.username,
  });
  if (!guard.allowed) return { taken: false, refusal: guard.refusal };
  const organizationId = guard.org.id;
  const checkpointId = newFolderId('ck', now());
  const locked = store.lock(organizationId, 'take', checkpointId);
  if ('busy' in locked) {
    return { taken: false, refusal: lockedRefusal(request.orgName, locked.busy) };
  }
  let folder: CheckpointFolder | undefined;
  let taking: OrgCheckpoint | undefined;
  try {
    const writing = await deps.runWriting?.(organizationId);
    if (writing !== undefined) {
      return { taken: false, refusal: { code: 'RUN_WRITING', message: writing } };
    }
    const reader = compositeReader(org, signal);
    const edition = await editionOf(org, guard.org);
    const budget = await readBudget(org, request.orgName);
    report(2, `Reading the objects of ${request.orgName}`);
    count.enter('scope');
    const scope = await describeScope(org, reader, request);
    count.enter('start');
    const userId = await org.userId();
    const automatedProcessUserId = await automatedProcessUserOf(org);
    const readFrom = await org.serverTime();
    report(8, `Counting the records of ${scope.objects.length} objects`);
    count.enter('counts');
    const plan = await planOf(org, reader, request, scope, budget, signal);
    if (plan.refusal !== undefined) return { taken: false, refusal: plan.refusal };
    if (plan.objects.length === 0) {
      throw new Error(
        `None of the objects asked for can be kept in a checkpoint of ${request.orgName}: ` +
          `${plan.leftOut.map((out) => `${out.objectApiName}: ${out.reason}`).join(' ') || 'there are none.'}`,
      );
    }
    if (signal?.aborted) throw new CheckpointTakeStopped();

    folder = await store.create(organizationId, checkpointId);
    const snapshotId = `snapshot-${checkpointId}`;
    taking = {
      version: 1,
      checkpointId,
      name: named ?? defaultNameOf(readFrom),
      org: {
        organizationId,
        ...(request.alias !== undefined ? { alias: request.alias } : {}),
        username: request.username,
        instanceUrl: request.instanceUrl,
        isSandbox: guard.org.sandbox,
        organizationType: edition,
        tier: guard.tier,
        ...(request.scratchExpiresAt !== undefined
          ? { scratchExpiresAt: request.scratchExpiresAt }
          : {}),
      },
      takenBy: {
        userId,
        ...(automatedProcessUserId !== undefined ? { automatedProcessUserId } : {}),
        viewAllData: true,
        modifyAllData: true,
      },
      readFrom,
      takenAt: readFrom,
      scope: { mode: request.mode, leftOut: plan.leftOut },
      objects: [],
      ignoredFields,
      snapshotId,
      movedWhileTaken: { changed: 0, deleted: 0, created: 0 },
      bytes: 0,
      expiresAt: expiresAtFor(now(), keepDays),
      status: 'taking',
      takenOn: { host: hostname(), pid: process.pid },
    };
    await store.write(taking);

    report(12, 'Reading the recycle bin as it was at the checkpoint');
    count.enter('bin');
    const bin = await spoolReads(
      reader,
      plan.objects.map(({ scoped }) => ({
        ...binLedgerRead(scoped.objectApiName, readFrom),
        file: binFileOf(folder as CheckpointFolder, scoped.objectApiName),
      })),
      signal,
    );
    const inBin = new Map<string, number>();
    for (const outcome of bin) {
      if (!outcome.read) {
        throw new Error(
          `The recycle bin of ${outcome.objectApiName} could not be read whole: ${outcome.reason}`,
        );
      }
      inBin.set(outcome.objectApiName, outcome.rows);
    }

    count.enter('snapshot');
    const records = await snapshotOf(
      folder,
      snapshotId,
      plan,
      request,
      deps,
      organizationId,
      report,
    );

    report(88, 'Reading the time on the org');
    count.enter('stability');
    const takenAt = await org.serverTime();
    report(90, `Checking what changed in ${request.orgName} while it was read`);
    const { movedWhileTaken, notChecked } = await stabilityOf(
      folder,
      snapshotId,
      plan,
      reader,
      readFrom,
      takenAt,
      signal,
    );

    const { prints } = plan;
    await store.writeFingerprints(folder, prints);
    const objects: CheckpointObject[] = plan.objects.map((object) => {
      const name = object.scoped.objectApiName;
      return entryOf(object, records.get(name) ?? 0, inBin.get(name) ?? 0, prints[name].digest);
    });
    if (signal?.aborted) throw new CheckpointTakeStopped();
    const ready: OrgCheckpoint = {
      ...taking,
      takenAt,
      objects,
      movedWhileTaken,
      bytes: 0,
      expiresAt: expiresAtFor(now(), keepDays),
      status: 'ready',
    };
    const checkpoint: OrgCheckpoint = { ...ready, bytes: await bytesKept(folder, ready) };
    await store.write(checkpoint);
    report(100, `Checkpoint '${checkpoint.name}' taken`, objects.length, objects.length);
    const requests = count.requests();
    return {
      taken: true,
      checkpoint,
      notChecked,
      ...(requests !== undefined ? { requests } : {}),
      estimate: plan.estimate,
    };
  } catch (err: unknown) {
    if (folder !== undefined) await discard(store, folder, taking, deps);
    if (stopped(err, signal)) throw new CheckpointTakeStopped();
    throw err;
  } finally {
    locked.lock.release();
  }
}

/**
 * Read every object of the plan that holds records into the snapshot,
 * children first, then index each object's file: one row per record, as many
 * as the read kept, or the take fails. An object counted empty is held as one
 * read empty: an empty file and an empty index. The files are written
 * through the take's snapshot files, compressed unless it was given others.
 *
 * @returns The rows the snapshot holds of each object.
 */
async function snapshotOf(
  folder: CheckpointFolder,
  snapshotId: string,
  plan: Plan,
  request: TakeRequest,
  deps: TakeDeps,
  organizationId: string,
  report: (percentage: number, step: string, processed?: number, total?: number) => void,
): Promise<Map<string, number>> {
  const read = plan.objects.filter((object) => object.records > 0);
  const kept = new Map<string, number>();
  const files = (deps.snapshotFiles ?? compressedFilesOf)(folder.dir);
  if (read.length > 0) {
    const cap = Math.max(SNAPSHOT_CAP_MIN, plan.objectLimit);
    const { handler, config } = await snapshotHandlerOf(
      folder,
      files,
      deps,
      cap,
      (percentage, step) => report(15 + percentage * 0.65, step),
    );
    const taken = await handler.backupForPipeline(
      {
        operationId: snapshotId,
        orgId: request.orgId,
        objects: read.map(({ scoped }) => scoped.objectApiName),
        fields: new Map(read.map(({ scoped, capture }) => [scoped.objectApiName, capture.fields])),
        scanAll: read
          .filter(({ capture }) => capture.readMode === 'scanAllLive')
          .map(({ scoped }) => scoped.objectApiName),
        origin: 'checkpoint',
        failWhenTruncated: true,
        // The snapshot reads through a connection of its own: what it sends
        // is counted with the take's.
        onConnection: (connection) => deps.org.countAlso?.(connection),
      },
      deps.signal,
    );
    // The handler connects through the registry, the take through its own
    // connection: an alias pointed at another org between the two would
    // have the checkpoint of one org hold the records of another.
    const meta = snapshotMetaSchema.safeParse(config.get<unknown>(`backup:${snapshotId}`));
    const readFromOrg = meta.success ? meta.data.organizationId : undefined;
    if (readFromOrg === undefined || !sameOrganization(readFromOrg, organizationId)) {
      throw new Error(
        `The snapshot was read from ${readFromOrg === undefined ? 'an org that did not say which it is' : `another org (${readFromOrg})`}, ` +
          `not from ${request.orgName}: it is not kept.`,
      );
    }
    for (const object of taken.objects) kept.set(object.objectApiName, object.recordCount);
  }
  report(82, 'Indexing the snapshot', 0, plan.objects.length);
  for (const [at, { scoped }] of plan.objects.entries()) {
    const name = scoped.objectApiName;
    const rows = kept.get(name) ?? 0;
    if (!kept.has(name)) {
      await makePrivateDir(join(folder.dir, 'backups'));
      await files.writeFile(snapshotFileOf(folder, snapshotId, name), '');
      kept.set(name, 0);
    }
    const index = await writeSnapshotIndex(folder, snapshotId, name);
    if (index.rows !== rows) {
      throw new CheckpointStoreError(
        'damaged',
        `The snapshot of ${name} holds ${index.rows} records where its read kept ${rows}: it is not kept.`,
      );
    }
    report(
      82 + (6 * (at + 1)) / plan.objects.length,
      `Indexed ${name}`,
      at + 1,
      plan.objects.length,
    );
  }
  return kept;
}

/**
 * What moved in each object of the plan between its read and T1, read once
 * T1 is: the newest stamp of each object, then what moved since T0 in those
 * that did. An object whose read failed is named, not counted: the
 * checkpoint holds it whole all the same.
 */
async function stabilityOf(
  folder: CheckpointFolder,
  snapshotId: string,
  plan: Plan,
  reader: CompositeReader,
  readFrom: string,
  takenAt: string,
  signal: AbortSignal | undefined,
): Promise<{ movedWhileTaken: Moved; notChecked: NotChecked[] }> {
  const dir = join(folder.dir, STABILITY_DIR);
  const movedWhileTaken: Moved = { changed: 0, deleted: 0, created: 0 };
  const notChecked: NotChecked[] = [];
  try {
    const changes = await readChanges(
      reader,
      plan.objects.map(({ capture }) => ({
        objectApiName: capture.objectApiName,
        readMode: capture.readMode,
        held: false,
      })),
      readFrom,
      dir,
      signal,
    );
    const t0s = Date.parse(soqlInstant(readFrom));
    const t1 = Date.parse(takenAt);
    for (const change of changes) {
      if ('unread' in change) {
        notChecked.push({ objectApiName: change.objectApiName, reason: change.unread });
        continue;
      }
      if (!change.moved) continue;
      const moved = await movedOf(folder, snapshotId, change.objectApiName, change, t0s, t1);
      movedWhileTaken.changed += moved.changed;
      movedWhileTaken.deleted += moved.deleted;
      movedWhileTaken.created += moved.created;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return { movedWhileTaken, notChecked };
}

/**
 * Keep nothing of a take that did not end: its checkpoint marked failed —
 * never used, should its folder outlive what follows — then its folder
 * removed, the records' values with it.
 */
async function discard(
  store: OrgCheckpointStore,
  folder: CheckpointFolder,
  taking: OrgCheckpoint | undefined,
  deps: TakeDeps,
): Promise<void> {
  try {
    if (taking !== undefined) await store.write({ ...taking, status: 'failed' });
  } catch (err: unknown) {
    deps.handler.log(
      `[WARN] checkpoint ${folder.checkpointId}: not marked failed: ${extractErrorMessage(err)}`,
    );
  }
  try {
    await rm(folder.dir, { recursive: true, force: true });
  } catch (err: unknown) {
    deps.handler.log(
      `[WARN] checkpoint ${folder.checkpointId}: what its take wrote was not removed: ${extractErrorMessage(err)}`,
    );
  }
}
