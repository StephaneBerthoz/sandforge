/**
 * An emptying from end to end, as the DataOps page and the command line both
 * ask for one: its dry run, its run, and its undo, each behind the same
 * guards, in the order every write path keeps (`beforeRunCheckpoint.ts`):
 * the reads, the plan of the mute, the question, the checkpoint, the lease,
 * the writes, the lease given back, the result.
 *
 * **Refused before anything is read**: a production org, whatever is set
 * (`emptyGuard.ts`); the whole of a sandbox marked Staging.
 *
 * **Refused before anything is deleted**, every refusal said at once, the
 * first as the refusal and the others beside it:
 *
 * - another act of this machine writes to the org, or holds its lock — a
 *   take, a rewind, an undo, another emptying (`RUN_WRITING`);
 * - the org's last emptying stopped part way: resume it or undo it first
 *   (`OPEN_RUN`), so that its Undo always reaches the org as it was before it;
 * - for good, a user without Bulk API Hard Delete;
 * - someone other than the user changed records of these objects in the last
 *   hour (`PEOPLE_ACTIVE`), as a rewind held to it refuses — unless their
 *   work is accepted to go, which covers the people the preview named alone;
 * - records no undo would bring back, not accepted (`NO_UNDO`), as a rewind
 *   asks it;
 * - more requests, or Bulk API batches, than the org has left today;
 * - what fires as the records go, its emails and its mute, as every DataOps
 *   act asks them (`readDataOpsAct`);
 * - the checkpoint asked for first, refused by its own guards — past 500,000
 *   records among them;
 * - **the org changed beyond what was accepted**. The rewind's rule: a run
 *   never does more than its user confirmed (`rewindPlan.ts`). The run reads
 *   the dry run again and refuses when the org would now take more than the
 *   preview showed — an object it did not show, more records going along with
 *   those it deletes, more that no undo would bring back — or when the user
 *   now sees less than they did. Records of the objects emptied made since
 *   are no refusal: the run never reads them (`emptyRun.ts`), and leaves
 *   them, counted. A preview stopped before every count was in is never acted
 *   on (`PREVIEW_STOPPED`).
 *
 * Then Production Guard is asked — a delete, or a hard delete — the
 * checkpoint taken, the org's lock taken for the whole run, the mute's lease
 * taken; and once the deletes are through, the jobs the org may still be
 * running are waited for before the lease is given back.
 *
 * Once a run ended, the journals of the org's earlier emptyings go: Undo
 * reaches its last emptying alone, as a rewind's reaches its last rewind.
 */

import * as z from 'zod';
import type {
  DataOpsAutomationAnswer,
  DataOpsEmptyPassResult,
  DataOpsEmptyPreviewKept,
  DataOpsEmptyRefusal,
  DataOpsEmptyRunResult,
  DataOpsEmptyUndoResult,
  DataOpsWriteAccord,
  GuardDecision,
  MutedAutomation,
  OrgTypeAndEdition,
  RunCheckpointEstimate,
  RunCheckpointInfo,
} from '@sandforge/shared';
import { removalStepsWrites, stillRunningOf } from '@sandforge/shared';
import { extractErrorMessage } from '../../../core/common/extractErrorMessage.js';
import { limitSplitting, splitAllowanceAnswerOf } from '../../../core/common/governorLimit.js';
import type { Connection } from 'jsforce';
import type { DeleteMode } from '../../../core/removal/deleteRecords.js';
import type { MuteLeaseOptions, HeldMute } from '../../forge/AutomationMuteLease.js';
import { muteLeaseRequests, muteLines } from '../../forge/AutomationMuteLease.js';
import type { ApiBudget } from '../../forge/ForgeRunGate.js';
import type { BeforeRunAsk, BeforeRunCheckpoints } from '../../checkpoint/beforeRunCheckpoint.js';
import {
  checkpointDescribeSchema,
  type CheckpointDescribe,
} from '../../checkpoint/checkpointFields.js';
import { grantsByObject } from '../../checkpoint/checkpointGuard.js';
import { globalObjectSchema } from '../../checkpoint/checkpointScope.js';
import type { OrgLockHolder, OrgLockOutcome } from '../../checkpoint/OrgCheckpointStore.js';
import {
  dataOpsStop,
  holdDataOpsMute,
  readDataOpsAct,
  type DataOpsAutomationOrg,
  type DataOpsVoice,
} from '../dataOpsAutomation.js';
import { accessNarrowedSince, emptyAccessOf } from './emptyAccess.js';
import {
  ACTIVE_WINDOW_MS,
  NOTHING_READ,
  emptyPermissionsOf,
  guardEmpty,
  hardDeleteRefusal,
  namedPeople,
  peopleActiveIn,
  peopleActiveRefusal,
  type EmptyPermissions,
  type PeopleActive,
} from './emptyGuard.js';
import {
  EmptyJournalDamaged,
  newEmptyRunId,
  type EmptyJournal,
  type EmptyJournalHead,
  type EmptyJournalStore,
} from './emptyJournal.js';
import type { EmptyOrg } from './emptyOrg.js';
import { pricedWithReads } from './emptyCost.js';
import { previewEmpty, type EmptyPreview } from './emptyPreview.js';
import { emptyPasses } from './emptyRun.js';
import type { EmptyScopeRequest } from './emptyScope.js';
import { undoEmpty } from './emptyUndo.js';

/** What refuses a run once it stands before its first delete. */
const NOTHING_DELETED = 'Nothing was deleted.';

/** The question an emptying puts to Production Guard. */
export interface EmptyGuardQuestion {
  operation: 'delete' | 'hardDelete';
  objectNames: string[];
  recordCount: number;
}

/** Production Guard's answer: its decision, and why it refused when it did. */
export interface EmptyGuardAnswer {
  decision: GuardDecision;
  reason?: string;
}

/** What an emptying, its dry run and its undo work with. */
export interface EmptyActContext {
  org: EmptyOrg;
  /** The org's id in the registry. */
  orgId: string;
  /** How the user knows the org: its alias, else its username. */
  orgName: string;
  /** The user SandForge connects as. */
  username: string;
  /** The org as the registry holds it; undefined when it holds none, which is refused. */
  registered: OrgTypeAndEdition | undefined;
  store: EmptyJournalStore;
  /** Take the org's lock, as a take, a rewind and an undo take it (`OrgCheckpointStore.lock`). */
  lock: (organizationId: string) => OrgLockOutcome;
  /** What else of this machine writes to the org, as a refusal says it; nothing when none does. */
  runWriting?: (organizationId: string) => Promise<string | undefined>;
  /** What fires, the day's emails and the mute, as every DataOps act reads them. */
  automation: DataOpsAutomationOrg;
  muteLeases?: MuteLeaseOptions;
  /** Whose words its refusals are said in: the command line's unless told. */
  voice?: DataOpsVoice;
  /** The window's checkpoints before a run; absent, none can be taken first. */
  checkpoints?: Pick<BeforeRunCheckpoints, 'scope' | 'take' | 'settle'>;
  /** Ask Production Guard; never reached for a production org. */
  askGuard: (question: EmptyGuardQuestion) => Promise<EmptyGuardAnswer>;
  /** The act, as the checkpoint, the mute's lease and the audit trail name it. */
  operationId: string;
  /** Whether the panel or a command line runs it. */
  tool: 'panel' | 'cli';
  /**
   * Every request the act has sent the org so far, through each connection
   * it reads and deletes through, counted as sent; absent where nothing
   * counts them. A dry run's estimate holds its reads as counted.
   */
  requestsSent?: () => number;
  signal?: AbortSignal;
  onProgress?: (percentage: number, step: string) => void;
  /** This machine's clock. */
  now?: () => Date;
}

/** What a dry run is asked. */
export interface EmptyPreviewAsk {
  request: EmptyScopeRequest;
  deleteMode: DeleteMode;
  accord: DataOpsWriteAccord;
  acceptNoUndo?: boolean;
  /** Say what a run accepting the work of the people at work would meet: theirs is no refusal. */
  acceptPeopleActive?: boolean;
  /** Price the checkpoint a run would take first. */
  checkpointFirst?: boolean;
}

/** A dry run, as it is kept for the run that acts on it. */
export interface EmptyKeptPreview extends DataOpsEmptyPreviewKept {
  preview: EmptyPreview;
  request: EmptyScopeRequest;
  /** The org it read, by its Organization Id: a refreshed sandbox is another. */
  organizationId: string;
}

/** What a dry run answers. */
export type EmptyPreviewAnswer =
  | {
      previewed: true;
      kept: EmptyKeptPreview;
      automation: DataOpsAutomationAnswer;
      /** What the run would meet now, as asked: the first stops it. */
      refusals: DataOpsEmptyRefusal[];
      /** The requests the dry run sent the org, as counted; absent where nothing counts them. */
      requestsSent?: number;
    }
  | { previewed: false; refusal: DataOpsEmptyRefusal };

/** What a run is asked: a preview to act on, or a run to take up. */
export interface EmptyRunAsk {
  confirmed?: EmptyKeptPreview;
  resumeRunId?: string;
  accord: DataOpsWriteAccord;
  acceptNoUndo?: boolean;
  /**
   * Empty although people other than the user changed records of these
   * objects in the last hour: those the preview confirmed named — someone it
   * did not name refuses the run all the same —, or, taking up a run, whoever.
   */
  acceptPeopleActive?: boolean;
  checkpointFirst?: boolean;
}

/** What a run answers. */
export type EmptyRunAnswer =
  | { ran: true; result: DataOpsEmptyRunResult; guard?: GuardDecision }
  | {
      ran: false;
      refusal: DataOpsEmptyRefusal;
      alsoRefused?: DataOpsEmptyRefusal[];
      guard?: GuardDecision;
      mutedAutomation?: MutedAutomation;
    };

/** What an undo is asked. */
export interface EmptyUndoAsk {
  runId: string;
  accord: DataOpsWriteAccord;
}

/** What an undo answers. */
export type EmptyUndoAnswer =
  | { ran: true; result: DataOpsEmptyUndoResult }
  | {
      ran: false;
      refusal: DataOpsEmptyRefusal;
      alsoRefused?: DataOpsEmptyRefusal[];
      mutedAutomation?: MutedAutomation;
    };

// ─── Small reads ─────────────────────────────────────────────────────────────

/** The connection the guards and the user's permissions are read through: queries alone. */
function guardConnectionOf(org: EmptyOrg): Pick<Connection, 'query' | 'queryMore'> {
  return {
    query: (soql: string) => org.query(soql),
    queryMore: (url: string) => org.queryMore(url),
  } as unknown as Pick<Connection, 'query' | 'queryMore'>;
}

const limitSchema = z.object({ Max: z.number(), Remaining: z.number() }).loose();
const limitsSchema = z
  .object({
    DailyApiRequests: limitSchema.optional(),
    DailyBulkApiBatches: limitSchema.optional(),
    DataStorageMB: limitSchema.optional(),
  })
  .loose();

/** What an emptying reads of the org's `/limits`: its day's requests and batches, and its storage. */
export async function readEmptyLimits(org: Pick<EmptyOrg, 'limits'>): Promise<{
  apiBudget: ApiBudget | { unread: string };
  bulkBatches?: ApiBudget;
  dataStorageMB?: number;
}> {
  try {
    const limits = limitsSchema.parse(await org.limits());
    const budget = (limit: z.infer<typeof limitSchema> | undefined): ApiBudget | undefined =>
      limit ? { max: limit.Max, remaining: limit.Remaining } : undefined;
    const api = budget(limits.DailyApiRequests);
    const batches = budget(limits.DailyBulkApiBatches);
    return {
      apiBudget: api ?? { unread: 'the limits the org answered list no DailyApiRequests' },
      ...(batches ? { bulkBatches: batches } : {}),
      ...(limits.DataStorageMB ? { dataStorageMB: limits.DataStorageMB.Max } : {}),
    };
  } catch (err: unknown) {
    return { apiBudget: { unread: extractErrorMessage(err) } };
  }
}

/** The org's Automated Process users: the org's own writes, never a person at work. */
async function automatedProcessOf(org: EmptyOrg): Promise<string[]> {
  try {
    const answer = await org.query("SELECT Id FROM User WHERE UserType = 'AutomatedProcess'");
    return answer.records.map((row) => row.Id).filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

/** The objects a preview deletes records of: emptied and going along, those it counted none of left out. */
function objectsGoing(preview: EmptyPreview): string[] {
  const holds = (counted: { records?: number }): boolean =>
    counted.records === undefined || counted.records > 0;
  return [
    ...preview.passes.filter((pass) => holds(pass.records)).map((pass) => pass.objectApiName),
    ...preview.along.filter((along) => holds(along.records)).map((along) => along.objectApiName),
  ];
}

/** The records a preview's run writes, per object, as what fires and its emails are read on them. */
function writesOf(preview: EmptyPreview): {
  objects: Array<{ objectApiName: string; records: number }>;
  steps: { delete: string[]; setToDraft?: string[] };
  written: Array<{ objectApiName: string; write: 'delete' | 'update'; records: number }>;
} {
  const deletes = preview.passes
    .map((pass) => ({ objectApiName: pass.objectApiName, records: pass.sent.records ?? 0 }))
    .filter((object) => object.records > 0);
  const drafted = preview.refusals
    .filter((refusal) => refusal.code === 'activatedOrder' && (refusal.records.records ?? 0) > 0)
    .map((refusal) => ({
      objectApiName: refusal.objectApiName,
      records: refusal.records.records ?? 0,
    }));
  const objects = [...deletes];
  for (const each of drafted) {
    if (!objects.some((object) => object.objectApiName === each.objectApiName)) objects.push(each);
  }
  return {
    objects,
    steps: {
      delete: deletes.map((object) => object.objectApiName),
      ...(drafted.length > 0 ? { setToDraft: drafted.map((each) => each.objectApiName) } : {}),
    },
    written: [
      ...deletes.map((object) => ({ ...object, write: 'delete' as const })),
      ...drafted.map((object) => ({ ...object, write: 'update' as const })),
    ],
  };
}

/** The describes of `names`, those the org would not give left out. */
async function describesOf(org: EmptyOrg, names: readonly string[]): Promise<CheckpointDescribe[]> {
  const described: CheckpointDescribe[] = [];
  for (const name of names) {
    try {
      const parsed = checkpointDescribeSchema.safeParse(await org.describe(name));
      if (parsed.success) described.push(parsed.data);
    } catch {
      // Not described: the coverage reads it as an object it could not prove.
    }
  }
  return described;
}

/** The refusal of an act while another act of the org holds its lock. */
function lockedRefusal(orgName: string, holder: OrgLockHolder): DataOpsEmptyRefusal {
  const what =
    holder.operation === 'take'
      ? `A checkpoint of ${orgName} is being taken`
      : holder.operation === 'rewind'
        ? `A rewind is writing to ${orgName}`
        : holder.operation === 'undo'
          ? `An undo is writing to ${orgName}`
          : holder.operation === 'empty'
            ? `An emptying of its objects, or its undo, is writing to ${orgName}`
            : `SandForge is deleting checkpoints of ${orgName}`;
  return {
    code: 'RUN_WRITING',
    message: `${what} (process ${holder.pid} on ${holder.host}): empty once it has ended. ${NOTHING_DELETED}`,
  };
}

/** What a gate's refusals answer, the first as the refusal. */
function refusedFor(
  refusals: readonly DataOpsEmptyRefusal[],
  extra: { guard?: GuardDecision; mutedAutomation?: MutedAutomation } = {},
): Extract<EmptyRunAnswer, { ran: false }> {
  const [refusal, ...also] = refusals;
  return { ran: false, refusal, ...(also.length > 0 ? { alsoRefused: also } : {}), ...extra };
}

/** The org's last emptying, when it stopped part way, and its journal. */
async function openRunOf(
  store: EmptyJournalStore,
  organizationId: string,
): Promise<{ runId: string; startedAt: string; journal: EmptyJournal } | undefined> {
  const last = await store.lastOf(organizationId);
  if (!last) return undefined;
  let journal: EmptyJournal;
  try {
    journal = await store.open(organizationId, last.runId);
  } catch (err: unknown) {
    if (err instanceof EmptyJournalDamaged) return undefined;
    throw err;
  }
  const state = await journal.state();
  return state.open ? { runId: last.runId, startedAt: state.head.startedAt, journal } : undefined;
}

/** The refusal of a new run while the org's last one is open. */
function openRunRefusal(orgName: string, runId: string): DataOpsEmptyRefusal {
  return {
    code: 'OPEN_RUN',
    message:
      `The last emptying of ${orgName} (${runId}) stopped part way: resume it, or undo it, ` +
      `before another one starts, so that its Undo still reaches the org as it was. ${NOTHING_DELETED}`,
  };
}

/** What an entry of what no undo brings back is, in a few words. */
export function undoLostWords(entry: EmptyPreview['undoLost'][number]): string {
  switch (entry.reason) {
    case 'notRestorable':
      return `${entry.objectApiName}, which Salesforce does not bring back`;
    default:
      return `${entry.objectApiName} before ${entry.parent ?? 'their parent'}`;
  }
}

/** The refusal of records no undo would bring back, not accepted. */
function noUndoRefusal(preview: EmptyPreview): DataOpsEmptyRefusal | undefined {
  if (preview.deleteMode !== 'recycle') return undefined;
  const lost = preview.undoLost.filter(
    (entry) => entry.records.records === undefined || entry.records.records > 0,
  );
  if (lost.length === 0) return undefined;
  const records = lost.reduce((sum, entry) => sum + (entry.records.records ?? 0), 0);
  const named = [...new Set(lost.map(undoLostWords))];
  const before = lost.some(
    (entry) => entry.reason === 'restricted' || entry.reason === 'unordered',
  );
  return {
    code: 'NO_UNDO',
    message:
      `${records.toLocaleString('en-US')} record(s) would stay gone after Undo ` +
      `(${named.slice(0, 5).join(', ')}${named.length > 5 ? ', …' : ''})` +
      (before
        ? ': some go before a record they name, as Salesforce requires, and once both have ' +
          'gone, Undo cannot bring them back'
        : '') +
      '. Accept it to empty all the same, or leave those objects out. ' +
      NOTHING_DELETED,
  };
}

/** The refusals of a preview's cost against the org's day. */
function budgetRefusals(preview: EmptyPreview, orgName: string): DataOpsEmptyRefusal[] {
  const refusals: DataOpsEmptyRefusal[] = [];
  const { api, batches } = preview.cost;
  if (api.verdict === 'exceeds') {
    refusals.push({
      code: 'API_BUDGET',
      message:
        `The emptying takes about ${api.estimate.toLocaleString('en-US')} API requests, and ` +
        `${orgName} has ${api.remaining.toLocaleString('en-US')} left today. Empty fewer objects, ` +
        `or tomorrow. ${NOTHING_DELETED}`,
    });
  }
  if (batches?.verdict === 'exceeds') {
    refusals.push({
      code: 'BULK_BATCHES',
      message:
        `The emptying's Bulk API jobs take about ${batches.estimate.toLocaleString('en-US')} ` +
        `batches, and ${orgName} has ${batches.remaining.toLocaleString('en-US')} left today. ` +
        `Empty fewer records, or tomorrow. ${NOTHING_DELETED}`,
    });
  }
  return refusals;
}

/** The counts of `counted` known, or nothing. */
function known(counted: { records?: number }): number | undefined {
  return counted.records;
}

/**
 * Where `fresh` would take more than `confirmed` showed: see the module's
 * comment for the rule. Each in words; none when the org changed only
 * within what was accepted.
 */
export function changedSince(confirmed: EmptyPreview, fresh: EmptyPreview): string[] {
  const changes: string[] = [];
  const passes = new Map(confirmed.passes.map((pass) => [pass.objectApiName, pass]));
  for (const pass of fresh.passes) {
    const before = passes.get(pass.objectApiName);
    const now = known(pass.records);
    if (!before) {
      if (now === undefined || now > 0) changes.push(`${pass.objectApiName} is now emptied too`);
      continue;
    }
    if (now === undefined && known(before.records) !== undefined) {
      changes.push(
        `${pass.objectApiName} could not be counted again (${pass.records.unread ?? ''})`,
      );
    }
  }
  const along = new Map(confirmed.along.map((object) => [object.objectApiName, object]));
  for (const object of fresh.along) {
    const before = along.get(object.objectApiName);
    const now = known(object.records);
    const then = before ? known(before.records) : 0;
    if (now === undefined) {
      if (then !== undefined)
        changes.push(`what goes along of ${object.objectApiName} could not be counted again`);
      continue;
    }
    if (then !== undefined && now > then) {
      changes.push(
        `${now.toLocaleString('en-US')} ${object.objectApiName} record(s) now go along, where the ` +
          `preview counted ${then.toLocaleString('en-US')}`,
      );
    }
  }
  if (fresh.deleteMode === 'recycle') {
    const lostOf = (preview: EmptyPreview): number =>
      preview.undoLost.reduce((sum, entry) => sum + (entry.records.records ?? 0), 0);
    const pairs = (preview: EmptyPreview): Set<string> =>
      new Set(
        preview.undoLost.map(
          (entry) => `${entry.objectApiName}.${entry.field ?? ''}.${entry.reason}`,
        ),
      );
    const before = pairs(confirmed);
    const added = [...pairs(fresh)].filter((pair) => !before.has(pair));
    if (added.length > 0 || lostOf(fresh) > lostOf(confirmed)) {
      changes.push('more records would go beyond what Undo brings back');
    }
  }
  return changes;
}

/** The refusal of a run whose org changed beyond what its preview showed. */
function changedRefusal(orgName: string, changes: readonly string[]): DataOpsEmptyRefusal {
  return {
    code: 'ORG_CHANGED',
    message:
      `${orgName} changed since the preview, beyond what was confirmed: ${changes.slice(0, 5).join('; ')}` +
      `${changes.length > 5 ? '; …' : ''}. Preview the emptying again. ${NOTHING_DELETED}`,
  };
}

/** The checkpoint before an emptying, as the window's checkpoints are asked it. */
function checkpointAsk(
  context: EmptyActContext,
  preview: EmptyPreview,
  answer: DataOpsAutomationAnswer,
): BeforeRunAsk {
  const running = answer.automation
    ? stillRunningOf(answer.automation, answer.mutePlan, removalStepsWrites(answer.steps))
    : { firing: [] };
  return {
    module: 'empty',
    written: objectsGoing(preview),
    running: { firing: running.firing },
    request: {},
    orgId: context.orgId,
    operationId: context.operationId,
  };
}

// ─── The dry run ─────────────────────────────────────────────────────────────

/** Read the org as the run will, write nothing, and say it all: see the module's comment. */
export async function previewEmptyAct(
  context: EmptyActContext,
  ask: EmptyPreviewAsk,
): Promise<EmptyPreviewAnswer> {
  const { org, orgName } = context;
  const sentBefore = context.requestsSent?.() ?? 0;
  const conn = guardConnectionOf(org);
  const guard = await guardEmpty(conn, {
    orgName,
    registered: context.registered,
    mode: ask.request.mode,
  });
  if (!guard.allowed) return { previewed: false, refusal: guard.refusal };
  const firstRead = await readTheOrg(context, ask.request, ask.deleteMode);
  const answer = await readDataOpsAct({
    act: 'empty',
    target: orgName,
    org: context.automation,
    accord: ask.accord,
    mayMute: true,
    ...(context.muteLeases ? { muteLeases: context.muteLeases } : {}),
    ...(context.voice ? { voice: context.voice } : {}),
    ...writesAsked(firstRead.preview),
  });
  const open = await openRunOf(context.store, guard.org.id);
  const checkpoint =
    ask.checkpointFirst === true && context.checkpoints
      ? await context.checkpoints.scope(checkpointAsk(context, firstRead.preview, answer.answer), {
          operationId: context.operationId,
        })
      : undefined;
  // Its reads as they went, where they are counted: the run reads the org so
  // again before its first delete, and the estimate holds both.
  const requestsSent =
    context.requestsSent !== undefined ? context.requestsSent() - sentBefore : undefined;
  const read = pricedRead(firstRead, requestsSent, 2, muteLeaseRequests(answer.mute?.plan));
  const kept: EmptyKeptPreview = {
    previewId: newPreviewId(context.now?.() ?? new Date()),
    readAt: read.readAt,
    orgName,
    tier: guard.tier,
    preview: read.preview,
    request: ask.request,
    organizationId: guard.org.id,
    access: read.access,
    hardDelete: {
      permitted: read.permissions.hardDelete,
      ...(read.permissions.unread !== undefined ? { unread: read.permissions.unread } : {}),
    },
    peopleActive: keptPeople(read.people),
    ...(checkpoint ? { checkpoint } : {}),
    ...(open ? { openRun: { runId: open.runId, startedAt: open.startedAt } } : {}),
  };
  const refusals = await gateRefusals(context, guard.org.id, read, {
    deleteMode: ask.deleteMode,
    acceptNoUndo: ask.acceptNoUndo === true,
    ...(ask.acceptPeopleActive === true ? { peopleAccepted: true as const } : {}),
    automation: answer.answer,
    ...(checkpoint ? { checkpoint } : {}),
    ...(open ? { open: open.runId } : {}),
  });
  return {
    previewed: true,
    kept,
    automation: answer.answer,
    refusals,
    ...(requestsSent !== undefined ? { requestsSent } : {}),
  };
}

/**
 * `read` with its estimate priced on the requests its read took, as counted
 * (`pricedWithReads`), else as its describes and counts add up; holding
 * `readings` reads of the org: a dry run's own and its run's, or a run's
 * alone; and `mute`, what the lease of its mute sends.
 */
function pricedRead(
  read: OrgRead,
  sent: number | undefined,
  readings: 1 | 2,
  mute: number,
): OrgRead {
  const reads = sent ?? read.preview.cost.requests.reads;
  return {
    ...read,
    preview: { ...read.preview, cost: pricedWithReads(read.preview.cost, reads, readings, mute) },
  };
}

/** A preview's id: `ep-` and the time, then four random characters. */
function newPreviewId(now: Date): string {
  return newEmptyRunId(now).replace(/^em-/, 'ep-');
}

/** What a run's or a preview's read of the org came to. */
interface OrgRead {
  readAt: string;
  preview: EmptyPreview;
  permissions: EmptyPermissions;
  access: EmptyKeptPreview['access'];
  people: Awaited<ReturnType<typeof peopleActiveIn>>;
}

/** The writes a preview's run makes, as what fires is read on them. */
function writesAsked(preview: EmptyPreview): {
  objects: Array<{ objectApiName: string; records: number }>;
  writes: {
    steps: ReturnType<typeof writesOf>['steps'];
    written: ReturnType<typeof writesOf>['written'];
  };
} {
  const writes = writesOf(preview);
  return { objects: writes.objects, writes: { steps: writes.steps, written: writes.written } };
}

/** Read the org as a dry run does: its clock first, then the counts, the user and the people at work. */
async function readTheOrg(
  context: EmptyActContext,
  request: EmptyScopeRequest,
  deleteMode: DeleteMode,
): Promise<OrgRead> {
  const { org } = context;
  const conn = guardConnectionOf(org);
  // The org's clock before any count: what was made after it is never deleted.
  const readAt = await org.serverTime();
  const global = z
    .object({ sobjects: z.array(globalObjectSchema) })
    .loose()
    .parse(await org.describeGlobal()).sobjects;
  const tooling = await org.toolingObjects();
  const limits = await readEmptyLimits(org);
  const preview = await previewEmpty(
    {
      global,
      tooling,
      request,
      deleteMode,
      apiBudget: limits.apiBudget,
      ...(limits.bulkBatches ? { bulkBatches: limits.bulkBatches } : {}),
      ...(limits.dataStorageMB !== undefined ? { dataStorageMB: limits.dataStorageMB } : {}),
      stopped: () => context.signal?.aborted === true,
    },
    org,
  );
  const permissions = await emptyPermissionsOf(conn);
  const going = objectsGoing(preview);
  const settings = new Set(
    global.filter((object) => object.customSetting === true).map((object) => object.name),
  );
  const access = await emptyAccessOf({
    permissions,
    objects: going,
    customSettings: going.filter((name) => settings.has(name)),
    grants: async () => grantsByObject(conn, () => org.userId()),
    describe: (names) => describesOf(org, names),
  });
  const userId = await org.userId();
  const since = new Date(Date.parse(readAt) - ACTIVE_WINDOW_MS).toISOString();
  const active = await peopleActiveIn(
    org,
    going,
    [userId, ...(await automatedProcessOf(org))],
    since,
  );
  // Named for the page alone, beside the box that lets their work go: a
  // command line's output names no one.
  const people = context.voice === 'page' ? await namedPeople(org, active) : active;
  return { readAt, preview, permissions, access, people };
}

/** The people at work, as a preview keeps them for the page and for the run that acts on it. */
function keptPeople(people: PeopleActive): EmptyKeptPreview['peopleActive'] {
  return {
    people: people.people.length,
    ...(people.atLeast ? { atLeast: true as const } : {}),
    ...(people.who.length > 0 ? { who: people.who.map((person) => ({ ...person })) } : {}),
    ...(people.unread.length > 0 ? { unread: people.unread } : {}),
  };
}

/** How a refusal of people at work says what lifts it: the page's box, or the command line's flag. */
function peopleVoiceOf(context: Pick<EmptyActContext, 'voice'>): 'page' | 'flags' {
  return context.voice === 'page' ? 'page' : 'flags';
}

/** Every refusal a run with `read` would meet before its first delete, in their order. */
async function gateRefusals(
  context: EmptyActContext,
  organizationId: string,
  read: OrgRead,
  options: {
    deleteMode: DeleteMode;
    acceptNoUndo: boolean;
    /** Whose work at the org is accepted to go: the people a preview named, or whoever. */
    peopleAccepted?: true | readonly string[];
    automation: DataOpsAutomationAnswer;
    checkpoint?: RunCheckpointEstimate;
    open?: string;
  },
): Promise<DataOpsEmptyRefusal[]> {
  const refusals: DataOpsEmptyRefusal[] = [];
  const writing = await context.runWriting?.(organizationId);
  if (writing !== undefined) refusals.push({ code: 'RUN_WRITING', message: writing });
  if (options.open !== undefined) refusals.push(openRunRefusal(context.orgName, options.open));
  if (read.preview.stopped) {
    refusals.push({
      code: 'PREVIEW_STOPPED',
      message: `The preview was stopped before every count was in: preview again. ${NOTHING_READ}`,
    });
  }
  if (options.deleteMode === 'hard' && !read.permissions.hardDelete) {
    refusals.push(hardDeleteRefusal(read.permissions));
  }
  const people = peopleActiveRefusal(context.orgName, read.people, {
    ...(options.peopleAccepted !== undefined ? { accepted: options.peopleAccepted } : {}),
    voice: peopleVoiceOf(context),
  });
  if (people) refusals.push(people);
  const noUndo = options.acceptNoUndo ? undefined : noUndoRefusal(read.preview);
  if (noUndo) refusals.push(noUndo);
  refusals.push(...budgetRefusals(read.preview, context.orgName));
  if (options.checkpoint?.refusal) refusals.push({ ...options.checkpoint.refusal });
  const stop = dataOpsStop(options.automation);
  if (stop) refusals.push({ code: stop.code, message: stop.message }, ...stop.alsoRefused);
  return refusals;
}

// ─── The run ─────────────────────────────────────────────────────────────────

/** The result of a run that found nothing to delete: no journal is kept of it. */
function nothingToDelete(now: Date): DataOpsEmptyRunResult {
  const at = now.toISOString();
  return {
    runId: '',
    status: 'success',
    hard: false,
    passes: [],
    totals: { deleted: 0, gone: 0, refused: 0, notReached: 0 },
    undo: { offered: false, why: 'nothingDeleted' },
    notes: ['The org holds nothing the preview would delete any more: nothing was sent.'],
    startedAt: at,
    finishedAt: at,
  };
}

/** A request as the journal writes it: its lists copied. */
function journalRequestOf(request: EmptyScopeRequest): EmptyJournalHead['request'] {
  return {
    mode: request.mode,
    ...(request.objects ? { objects: [...request.objects] } : {}),
    ...(request.excluded ? { excluded: [...request.excluded] } : {}),
    ...(request.customSettings !== undefined ? { customSettings: request.customSettings } : {}),
    ...(request.files !== undefined ? { files: request.files } : {}),
    ...(request.managedPackages !== undefined ? { managedPackages: request.managedPackages } : {}),
    ...(request.unrestorable !== undefined ? { unrestorable: request.unrestorable } : {}),
  };
}

/** The totals of a run's passes. */
function totalsOf(passes: readonly DataOpsEmptyPassResult[]): DataOpsEmptyRunResult['totals'] {
  return passes.reduce(
    (totals, pass) => ({
      deleted: totals.deleted + pass.deleted,
      gone: totals.gone + pass.gone,
      refused: totals.refused + pass.refused,
      notReached: totals.notReached + (pass.notReached ?? 0),
    }),
    { deleted: 0, gone: 0, refused: 0, notReached: 0 },
  );
}

/**
 * Empty the org as `ask.confirmed` showed, or take up the run `ask.resumeRunId`
 * where it stopped: see the module's comment.
 *
 * @throws When the org fails part way: the journal says what was done, and
 *   the run is open, to be resumed or undone.
 */
export async function runEmptyAct(
  context: EmptyActContext,
  ask: EmptyRunAsk,
): Promise<EmptyRunAnswer> {
  const { org, orgName } = context;
  const now = context.now ?? (() => new Date());
  if (!ask.confirmed && ask.resumeRunId === undefined) {
    throw new Error('An emptying acts on a preview it was confirmed on, or takes up a run.');
  }
  const sentBefore = context.requestsSent?.() ?? 0;
  const conn = guardConnectionOf(org);
  const guard = await guardEmpty(conn, {
    orgName,
    registered: context.registered,
    mode: ask.confirmed?.request.mode ?? 'objects',
  });
  if (!guard.allowed) return { ran: false, refusal: guard.refusal };
  const organizationId = guard.org.id;

  // ─── What it acts on ───
  let resumed: EmptyJournal | undefined;
  const open = await openRunOf(context.store, organizationId);
  if (ask.resumeRunId !== undefined) {
    if (!open || open.runId !== ask.resumeRunId) {
      return {
        ran: false,
        refusal: {
          code: 'RUN_GONE',
          message:
            `${ask.resumeRunId} is not the last emptying of ${orgName} stopped part way: there is ` +
            `nothing of it to take up. ${NOTHING_DELETED}`,
        },
      };
    }
    resumed = open.journal;
    if (resumed.head.mode === 'org' && guard.tier === 'staging') {
      const staged = await guardEmpty(conn, {
        orgName,
        registered: context.registered,
        mode: 'org',
      });
      if (!staged.allowed) return { ran: false, refusal: staged.refusal };
    }
  } else if (
    ask.confirmed &&
    ask.confirmed.organizationId.slice(0, 15) !== organizationId.slice(0, 15)
  ) {
    return {
      ran: false,
      refusal: changedRefusal(orgName, [
        'it is another org than the one the preview read — a refreshed sandbox is a new org',
      ]),
    };
  }

  const confirmed = ask.confirmed;
  const deleteMode: DeleteMode = resumed
    ? resumed.head.deleteMode
    : (confirmed?.preview.deleteMode ?? 'recycle');
  const refusals: DataOpsEmptyRefusal[] = [];
  let read: OrgRead | undefined;
  let answer: Awaited<ReturnType<typeof readDataOpsAct>>;
  let checkpoint: RunCheckpointEstimate | undefined;
  if (confirmed) {
    // The dry run read again: refused past what it showed.
    read = await readTheOrg(context, confirmed.request, deleteMode);
    const changes = [
      ...changedSince(confirmed.preview, read.preview),
      ...accessNarrowedSince(confirmed.access, read.access).map(
        (objectApiName) => `the user is no longer proven to see every record of ${objectApiName}`,
      ),
    ];
    if (changes.length > 0) refusals.push(changedRefusal(orgName, changes));
    if (
      read.preview.total.records === 0 &&
      read.preview.total.uncounted.length === 0 &&
      changes.length === 0
    ) {
      return { ran: true, result: nothingToDelete(now()) };
    }
    answer = await readDataOpsAct({
      act: 'empty',
      target: orgName,
      org: context.automation,
      accord: ask.accord,
      mayMute: true,
      ...(context.muteLeases ? { muteLeases: context.muteLeases } : {}),
      ...(context.voice ? { voice: context.voice } : {}),
      ...writesAsked(read.preview),
    });
    if (ask.checkpointFirst === true) {
      checkpoint = context.checkpoints
        ? await context.checkpoints.scope(checkpointAsk(context, read.preview, answer.answer), {
            operationId: context.operationId,
          })
        : undefined;
      if (!checkpoint) {
        refusals.push({
          code: 'CHECKPOINT_REFUSED',
          message: `Checkpoints cannot be taken from here: run without Checkpoint first. ${NOTHING_DELETED}`,
        });
      }
    }
    // Held to what the org has left now, the dry run's reads spent: its own
    // read of the org as it went, and its passes.
    read = pricedRead(
      read,
      context.requestsSent !== undefined ? context.requestsSent() - sentBefore : undefined,
      1,
      muteLeaseRequests(answer.mute?.plan),
    );
    refusals.push(
      ...(await gateRefusals(context, organizationId, read, {
        deleteMode,
        acceptNoUndo: ask.acceptNoUndo === true,
        // The people its preview named, and no one else.
        ...(ask.acceptPeopleActive === true
          ? { peopleAccepted: (confirmed.peopleActive.who ?? []).map((person) => person.userId) }
          : {}),
        automation: answer.answer,
        ...(checkpoint ? { checkpoint } : {}),
        ...(open ? { open: open.runId } : {}),
      })),
    );
  } else {
    // A resume acts on what its journal confirmed: what fires and the people
    // at work are read again, on what is left.
    const head = (resumed as EmptyJournal).head;
    const permissions = await emptyPermissionsOf(conn);
    if (deleteMode === 'hard' && !permissions.hardDelete) {
      refusals.push(hardDeleteRefusal(permissions));
    }
    const writing = await context.runWriting?.(organizationId);
    if (writing !== undefined) refusals.push({ code: 'RUN_WRITING', message: writing });
    const objects = head.passes.map((pass) => pass.objectApiName);
    const userId = await org.userId();
    const at = await org.serverTime();
    const people = await peopleActiveIn(
      org,
      objects,
      [userId, ...(await automatedProcessOf(org))],
      new Date(Date.parse(at) - ACTIVE_WINDOW_MS).toISOString(),
    );
    const busy = peopleActiveRefusal(orgName, people, {
      ...(ask.acceptPeopleActive === true ? { accepted: true as const } : {}),
      voice: peopleVoiceOf(context),
    });
    if (busy) refusals.push(busy);
    const sends = head.passes
      .map((pass) => ({
        objectApiName: pass.objectApiName,
        records: pass.sent ?? pass.records ?? 0,
      }))
      .filter((pass) => pass.records > 0);
    answer = await readDataOpsAct({
      act: 'empty',
      target: orgName,
      objects: sends,
      org: context.automation,
      accord: ask.accord,
      mayMute: true,
      ...(context.muteLeases ? { muteLeases: context.muteLeases } : {}),
      ...(context.voice ? { voice: context.voice } : {}),
    });
    const stop = dataOpsStop(answer.answer);
    if (stop) refusals.push({ code: stop.code, message: stop.message }, ...stop.alsoRefused);
  }
  if (refusals.length > 0) return refusedFor(refusals);

  // ─── The question ───
  const going = confirmed && read ? read.preview : undefined;
  const recordCount = going
    ? going.total.records
    : (resumed as EmptyJournal).head.passes.reduce((sum, pass) => sum + (pass.records ?? 0), 0);
  const objectNames = going
    ? objectsGoing(going)
    : (resumed as EmptyJournal).head.passes.map((p) => p.objectApiName);
  const guarded = await context.askGuard({
    operation: deleteMode === 'hard' ? 'hardDelete' : 'delete',
    objectNames,
    recordCount,
  });
  if (guarded.decision === 'refused' || guarded.decision === 'declined') {
    return refusedFor(
      [
        {
          code: 'GUARD',
          message:
            guarded.decision === 'refused'
              ? `Production Guard refused the emptying: ${guarded.reason ?? 'no reason given'}. ${NOTHING_DELETED}`
              : `The emptying was declined at Production Guard's confirmation. ${NOTHING_DELETED}`,
        },
      ],
      { guard: guarded.decision },
    );
  }
  const guardDecision = guarded.decision;

  // ─── The checkpoint, taken before the org's lock, which its take holds itself ───
  let taken: RunCheckpointInfo | undefined;
  if (checkpoint && context.checkpoints && going) {
    const took = await context.checkpoints.take(
      checkpointAsk(context, going, answer.answer),
      { operationId: context.operationId },
      {
        planned: checkpoint,
        ...(context.signal ? { signal: context.signal } : {}),
        onProgress: ({ percentage }) =>
          context.onProgress?.(
            Math.round(percentage / 10),
            `Taking the checkpoint first (${Math.round(percentage)}%)`,
          ),
      },
    );
    if (!took.taken) {
      return refusedFor(
        [
          'stopped' in took
            ? {
                code: 'CANCELLED',
                message: `The emptying was stopped while its checkpoint was taken. ${NOTHING_DELETED}`,
              }
            : { code: took.refusal.code, message: took.refusal.message },
        ],
        { guard: guardDecision },
      );
    }
    taken = took.checkpoint;
  }
  const settleCheckpoint = async (wrote: boolean): Promise<RunCheckpointInfo | undefined> => {
    if (!taken || taken.state !== 'taken' || !context.checkpoints) return taken;
    try {
      return await context.checkpoints.settle(taken, wrote);
    } catch {
      return taken;
    }
  };

  // ─── The lock, for the whole run ───
  const locked = context.lock(organizationId);
  if ('busy' in locked) {
    await settleCheckpoint(false);
    return refusedFor([lockedRefusal(orgName, locked.busy)], { guard: guardDecision });
  }
  try {
    // Another emptying may have begun between the read and the lock.
    const openNow = await openRunOf(context.store, organizationId);
    if (!resumed && openNow) {
      await settleCheckpoint(false);
      return refusedFor([openRunRefusal(orgName, openNow.runId)], { guard: guardDecision });
    }

    // ─── The lease, as late as it can be ───
    const holding = await holdDataOpsMute(
      answer,
      context.operationId,
      ask.accord.acceptEmails === true,
      context.voice,
    );
    if ('refused' in holding) {
      await settleCheckpoint(false);
      return refusedFor([{ code: holding.refused.code, message: holding.refused.message }], {
        guard: guardDecision,
      });
    }
    const held: HeldMute | undefined = holding.held;

    const startedAt = now();
    const journal =
      resumed ??
      (await context.store.begin(organizationId, {
        runId: newEmptyRunId(startedAt),
        orgName,
        startedAt: startedAt.toISOString(),
        readAt: (confirmed as EmptyKeptPreview).readAt,
        previewId: (confirmed as EmptyKeptPreview).previewId,
        mode: (going as EmptyPreview).mode,
        deleteMode,
        request: journalRequestOf((confirmed as EmptyKeptPreview).request),
        passes: (going as EmptyPreview).passes.map((pass) => ({
          objectApiName: pass.objectApiName,
          ...(pass.records.records !== undefined ? { records: pass.records.records } : {}),
          ...(pass.sent.records !== undefined ? { sent: pass.sent.records } : {}),
          ...(pass.rows !== undefined ? { rows: pass.rows } : {}),
        })),
        toDraftAlong: (going as EmptyPreview).toDraftAlong,
        beforeParent: (going as EmptyPreview).beforeParent,
      }));

    const allowance =
      going && going.cost.api.verdict !== 'unread'
        ? splitAllowanceAnswerOf(going.cost.api).splitAllowance
        : undefined;
    let outcome: Awaited<ReturnType<typeof emptyPasses>> | undefined;
    let mutedAutomation: MutedAutomation | undefined;
    const notes: string[] = [];
    try {
      outcome = await emptyPasses({
        org: { deletion: org, ids: org },
        journal,
        resumed: resumed !== undefined,
        ...(context.signal ? { signal: context.signal } : {}),
        splitting: limitSplitting(allowance),
        now,
        onProgress: ({ percentage, step }) => context.onProgress?.(percentage, step),
      });
    } catch (err: unknown) {
      await journal.ended('failure', [], now()).catch(() => undefined);
      throw err;
    } finally {
      // A job the org may still be running deletes with every trigger and
      // flow the mute keeps quiet: waited for before the lease goes back.
      const lost = org.lostJobs?.() ?? [];
      if (lost.length > 0 && org.stillRunning) {
        const still = await org.stillRunning(lost);
        if (still.length > 0) {
          notes.push(
            `${still.length} Bulk API job(s) the org was still running after ten minutes: the ` +
              'mute was given back all the same, and what they delete from now on runs the ' +
              "org's automation.",
          );
        }
      }
      if (held) {
        mutedAutomation = await held.release();
        notes.push(...muteLines(mutedAutomation, orgName).map((line) => line.trim()));
      }
    }
    const passes = outcome.passes;
    const finishedAt = now();
    await journal.ended(outcome.status, passes, finishedAt, outcome.hardRefused);
    const info = await settleCheckpoint(outcome.deletedAny);

    // Undo reaches the org's last emptying alone: the journals of the earlier
    // ones go once this one ended.
    const removedRuns: string[] = [];
    if (outcome.status === 'success' || outcome.status === 'partial') {
      for (const run of await context.store.runsOf(organizationId)) {
        if (run.runId >= journal.head.runId) continue;
        await context.store.remove(organizationId, run.runId);
        removedRuns.push(run.runId);
      }
    }
    const state = await journal.state();
    const result: DataOpsEmptyRunResult = {
      runId: journal.head.runId,
      status: outcome.status,
      hard: outcome.hard,
      passes,
      totals: totalsOf(passes),
      ...(outcome.hardRefused !== undefined ? { hardRefused: outcome.hardRefused } : {}),
      undo: outcome.hard
        ? { offered: false, why: 'hard' }
        : state.deletedAny
          ? { offered: true }
          : { offered: false, why: 'nothingDeleted' },
      ...(resumed ? { resumed: true as const } : {}),
      notes: [...outcome.notes, ...(outcome.changed ? [outcome.changed.message] : []), ...notes],
      ...(mutedAutomation ? { mutedAutomation } : {}),
      ...(info ? { checkpoint: info } : {}),
      ...(removedRuns.length > 0 ? { removedRuns } : {}),
      ...(context.requestsSent !== undefined
        ? { requestsSent: context.requestsSent() - sentBefore }
        : {}),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
    };
    return { ran: true, result, guard: guardDecision };
  } finally {
    locked.lock.release();
  }
}

// ─── The undo ────────────────────────────────────────────────────────────────

/** Bring back what the org's last emptying deleted: see `emptyUndo.ts`. */
export async function undoEmptyAct(
  context: EmptyActContext,
  ask: EmptyUndoAsk,
): Promise<EmptyUndoAnswer> {
  const { org, orgName } = context;
  const now = context.now ?? (() => new Date());
  const sentBefore = context.requestsSent?.() ?? 0;
  const conn = guardConnectionOf(org);
  // An undo deletes nothing: a sandbox marked Staging may be given back what
  // its emptying took, objects or whole org alike.
  const guard = await guardEmpty(conn, {
    orgName,
    registered: context.registered,
    mode: 'objects',
  });
  if (!guard.allowed) return { ran: false, refusal: guard.refusal };
  const organizationId = guard.org.id;
  const unavailable = (code: string, message: string): EmptyUndoAnswer => ({
    ran: false,
    refusal: { code, message: `${message} Nothing was brought back.` },
  });

  let journal: EmptyJournal;
  try {
    journal = await context.store.open(organizationId, ask.runId);
  } catch (err: unknown) {
    if (err instanceof EmptyJournalDamaged) return unavailable('RUN_GONE', err.message);
    throw err;
  }
  const last = await context.store.lastOf(organizationId);
  if (last?.runId !== ask.runId) {
    return unavailable(
      'NOT_LAST_RUN',
      `${ask.runId} is not the last emptying of ${orgName}: Undo reaches the last one alone, as ` +
        'what a later emptying deleted may hang from what this one did.',
    );
  }
  const state = await journal.state();
  if (journal.head.deleteMode === 'hard') {
    return unavailable(
      'UNDO_UNAVAILABLE',
      `${ask.runId} deleted for good: Salesforce brings back nothing a hard delete took, what went ` +
        'along included.',
    );
  }
  if (state.undone) return unavailable('UNDO_UNAVAILABLE', `${ask.runId} was undone already.`);

  const writing = await context.runWriting?.(organizationId);
  const refusals: DataOpsEmptyRefusal[] = [];
  if (writing !== undefined) refusals.push({ code: 'RUN_WRITING', message: writing });
  const objects = journal.head.passes.map((pass) => ({
    objectApiName: pass.objectApiName,
    records: pass.records ?? 0,
  }));
  const answer = await readDataOpsAct({
    act: 'emptyUndo',
    target: orgName,
    objects,
    org: context.automation,
    accord: ask.accord,
    mayMute: true,
    ...(context.muteLeases ? { muteLeases: context.muteLeases } : {}),
    ...(context.voice ? { voice: context.voice } : {}),
    // It brings records back, and puts no value back.
    writes: { steps: { bringBack: objects.map((object) => object.objectApiName) }, written: [] },
  });
  const stop = dataOpsStop(answer.answer);
  if (stop) refusals.push({ code: stop.code, message: stop.message }, ...stop.alsoRefused);
  if (refusals.length > 0) {
    const [refusal, ...also] = refusals;
    return { ran: false, refusal, ...(also.length > 0 ? { alsoRefused: also } : {}) };
  }

  const locked = context.lock(organizationId);
  if ('busy' in locked) {
    return { ran: false, refusal: lockedRefusal(orgName, locked.busy) };
  }
  try {
    const holding = await holdDataOpsMute(
      answer,
      context.operationId,
      ask.accord.acceptEmails === true,
      context.voice,
    );
    if ('refused' in holding) {
      return {
        ran: false,
        refusal: { code: holding.refused.code, message: holding.refused.message },
      };
    }
    let mutedAutomation: MutedAutomation | undefined;
    let outcome: Awaited<ReturnType<typeof undoEmpty>>;
    try {
      outcome = await undoEmpty({
        org,
        undelete: (ids) => org.undelete(ids),
        journal,
        ...(context.signal ? { signal: context.signal } : {}),
        onProgress: ({ percentage, step }) => context.onProgress?.(percentage, step),
      });
    } finally {
      if (holding.held) mutedAutomation = await holding.held.release();
    }
    const finishedAt = now();
    if (outcome.status !== 'cancelled') await journal.undone(outcome.status, finishedAt);
    return {
      ran: true,
      result: {
        runId: ask.runId,
        status: outcome.status,
        objects: outcome.objects,
        notes: [
          ...outcome.notes,
          ...(mutedAutomation
            ? muteLines(mutedAutomation, orgName).map((line) => line.trim())
            : []),
        ],
        ...(mutedAutomation ? { mutedAutomation } : {}),
        ...(context.requestsSent !== undefined
          ? { requestsSent: context.requestsSent() - sentBefore }
          : {}),
        finishedAt: finishedAt.toISOString(),
      },
    };
  } finally {
    locked.lock.release();
  }
}
