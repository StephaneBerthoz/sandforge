import { AsyncLocalStorage } from 'node:async_hooks';

import { BYTES_PER_MB } from '@sandforge/shared';
import type { ForgeRemovalRisk, RunCheckpointEstimate, RunDeliverability } from '@sandforge/shared';

/** Safety tier classification for Salesforce orgs */
export type SafetyTier = 'production' | 'staging' | 'development' | 'scratch';

/** Describes an operation that needs safety verification */
export interface OperationRequest {
  orgId: string;
  orgTier: SafetyTier;
  /**
   * What the operation writes. `deploy` is a Metadata API deployment: it
   * writes components, not records, so `objectName` names their types and
   * `recordCount` counts the components.
   */
  operation: 'insert' | 'update' | 'upsert' | 'delete' | 'hardDelete' | 'deploy';
  objectName: string;
  /**
   * Records the operation plans to write. Callers that cannot know it
   * before the run (a clone queries its source afterwards, a masking run
   * queries each object) send `'unknown'`, which is shown as such and
   * counts as below every volume threshold. A measured 0 stays 0.
   *
   * A caller that knows only the most it can write sends `{ atMost }`, shown
   * as "at most" that many: a clone of one record is counted by the tables
   * its objects are read from, and writes the few rows of them its record
   * reaches. The volume thresholds measure that most, which the run may reach.
   */
  recordCount: number | 'unknown' | { atMost: number };
  /**
   * What the operation writes besides the records `recordCount` counts, said
   * after them. A Forge clone adds the catalog, order items and parents its
   * records name, objects no count taken before the run can hold: told only
   * "at most 60 Account, Case record(s)", the user read a bound on the whole
   * run, of which those objects were 34 records of 85 on a real clone.
   */
  alsoWrites?: string;
  module: string;
}

/** Result of a safety check on an operation request */
export interface SafetyCheckResult {
  allowed: boolean;
  requiresConfirmation: boolean;
  blockedReason?: string;
  warnings: string[];
  impactSummary: string;
  /**
   * What the confirmation asks, in plain words, the org named by its alias
   * (`confirmationQuestionOf`). Set only by a guard that can name the org
   * (`ProductionGuardOptions.orgNameOf`), and only on a result that asks.
   */
  question?: string;
}

const DESTRUCTIVE_OPERATIONS = new Set<string>(['delete', 'hardDelete']);

/** Volume thresholds that trigger safety gates per tier */
const STAGING_CONFIRMATION_THRESHOLD = 10_000;
const DEV_WARNING_THRESHOLD = 50_000;

/**
 * The volume past which a write to an org of `tier` is a large one, as the
 * guard's warning says it: 10 000 records on staging, which then asks, and
 * 50 000 on a sandbox or a scratch org, which never asks. A production write
 * is warned about whatever its volume, so it has none.
 *
 * The guard's check says it in `warnings`, which every write path dropped: a
 * run of 50 000 records into a sandbox went ahead without a word. A path that
 * puts a confirmation to the user says it there, against the volume it has
 * counted.
 */
export function largeVolumeThreshold(tier: SafetyTier): number | undefined {
  switch (tier) {
    case 'production':
      return undefined;
    case 'staging':
      return STAGING_CONFIRMATION_THRESHOLD;
    case 'development':
    case 'scratch':
      return DEV_WARNING_THRESHOLD;
  }
}

/**
 * One flow or Apex trigger of the target that fires as a run inserts its
 * records — or, in a question's `firedOnUpdate`, as it updates them.
 */
export interface FiredOnInsert {
  objectApiName: string;
  kind: 'flow' | 'trigger' | 'process' | 'workflowRule';
  /** The flow's or the process's label, the trigger's or the workflow rule's name. */
  name: string;
}

/**
 * Why a run writes a record it inserted a second time, as the executor's
 * steps do it:
 * - `lookups`: the second pass fills in a lookup left empty at insert, its
 *   record written after it — a lookup of a cycle, a record's lookup at
 *   another record of its object — once that record exists;
 * - `statuses`: an order or a contract past Draft goes in as a draft, so that
 *   its items can go under it, and is given its status back last;
 * - `invitees`: an event's invitee the platform wrote for its who is given the
 *   answer the source holds;
 * - `retry`: a retry fills in the lookups the run it retries left empty at the
 *   records it writes now;
 * - `upsert`: an upsert by an external id writes over a record the target
 *   holds (the clone command's `--upsert`).
 */
export type RunUpdateStep = 'lookups' | 'statuses' | 'invitees' | 'retry' | 'upsert';

/**
 * A custom permission that keeps quiet some of what fires, which the user the
 * run writes as does not hold, and what would give it to that user: the
 * smallest permission set of the target that includes it, the command that
 * assigns it — shown, never run — and the others that include it.
 */
export interface BypassToAssign {
  permission: string;
  /** The smallest permission set that includes it; absent when none does, or they were not read. */
  permissionSet?: string;
  /** The other permission sets that include it, the smallest first. */
  others: string[];
  /** True when the permission sets were read and none a user can be assigned includes it: an admin creates one. */
  noneHolds?: true;
  /** `sf org assign permset …` for `permissionSet`; absent without one, or without the user's name. */
  command?: string;
}

/**
 * What a run asks before it reads anything: what the target org runs as the
 * run inserts its records, and as it updates those it writes a second time.
 */
export interface AutomationConfirmation {
  stage: 'automation';
  /** The org the run writes to, as the user knows it. */
  org: string;
  orgTier: SafetyTier;
  /** What fires on insert, per object; empty when none was found in what could be read. */
  fired: FiredOnInsert[];
  /**
   * What fires on update, per object, on the objects whose records the run
   * updates after inserting them; empty when none fires there.
   */
  firedOnUpdate: FiredOnInsert[];
  /** Why the run updates records after inserting them: the steps that will, each once. */
  updateSteps: RunUpdateStep[];
  /**
   * What could not be read of the target's automation, and why: what fires
   * is then not known. `automation` when none of it could be read.
   */
  unread: Array<{
    part: 'flows' | 'triggers' | 'processes' | 'workflowRules' | 'automation';
    reason: string;
  }>;
  /** Custom permissions that keep some of those flows from starting for the user who holds them. */
  bypass: string[];
  /** Those of `bypass` the user the run writes as does not hold, with what would assign each. */
  assign: BypassToAssign[];
  /**
   * What may refuse the removal of the run's records, per object it writes:
   * a flow before a delete, an Apex trigger on one, records that lock past
   * Draft. Absent or empty when none was found.
   */
  removal?: ForgeRemovalRisk[];
  /**
   * What still runs that may send an email as the run writes, and whether
   * the target delivers them: the question's first block, put before what
   * still runs. Set when the target delivers them all or would not say, and
   * the answer then sends them ("Execute and send the emails"); absent when
   * nothing sends, or the target sends none of them.
   */
  deliverability?: RunDeliverability;
}

/**
 * What a run asks before it reads anything, when it reads source tables with
 * no cap per object past the most rows of one object it reads
 * (`sandforge.forge.maxRecordsPerObject`): a run of whole tables reads such a
 * table to that number, a page at a time, and a run from a record holds every
 * row it reads.
 */
export interface ReadConfirmation {
  stage: 'read';
  /** The org the run writes to, as the user knows it. */
  org: string;
  orgTier: SafetyTier;
  /** The org the tables are read from, as the user knows it. */
  source: string;
  /** The objects past the ceiling, with the rows discovery counted in each table, the most first. */
  objects: Array<{ objectApiName: string; rows: number }>;
  /** The most rows of one object the run reads, past which it asks. */
  ceiling: number;
}

/** The data storage a run's rows take, and what the target has: read, or not. */
export type WriteConfirmationStorage =
  | {
      estimateMB: number;
      maxMB: number;
      remainingMB: number;
      /** Whether the rows take more than 80 % of what is left. */
      near: boolean;
    }
  | { estimateMB: number; unread: string };

/**
 * What a run asks once it has read every row it writes, before it writes the
 * first: how many, and the storage they take.
 */
export interface WriteConfirmation {
  stage: 'write';
  /**
   * The module whose run asks: a Forge clone unless said. An Autopilot run
   * asks the same question of its plan, a Sync run of the records it
   * counted under each object's filter, and a seed of its template's.
   */
  module?: 'autopilot' | 'sync' | 'seed';
  /**
   * Of a Sync run of a saved configuration: the records an earlier run of it
   * copied, which this one leaves as they are and does not count. Absent when none.
   */
  alreadyCopied?: number;
  /**
   * Of a Sync run of a saved configuration: the records an earlier run of it
   * linked to a record the target held, which this one leaves as they are
   * and does not count. Absent when none.
   */
  alreadyLinked?: number;
  /**
   * Of a Sync run: the contact roles it links to the one the platform writes
   * with an opportunity it creates, for its contact, which it does not send
   * and does not count. Absent when none.
   */
  rolesLinked?: number;
  /**
   * Of a Sync run: of `total`, the records an update or an upsert writes,
   * which may write over records the target holds — their values are kept
   * first, and removing the run puts them back. Absent when none.
   */
  overwrites?: number;
  /** The org the run writes to, as the user knows it. */
  org: string;
  orgTier: SafetyTier;
  /** The rows to write, per object, the most first. */
  objects: Array<{ objectApiName: string; rows: number }>;
  total: number;
  /** The `sandforge.safety.confirmAboveRecords` value the total is past; absent when it is not. */
  aboveRecords?: number;
  /** The guard's large-volume line the total is past ({@link largeVolumeThreshold}); absent when it is not. */
  largeVolume?: number;
  storage: WriteConfirmationStorage;
  /**
   * What the run read or counted and will not write, left out of the rows
   * above: the rows the run it retries or resumes wrote, which it links to,
   * the objects held back whole for a record type closed to the user it
   * writes as, the rows the platform writes itself with a record the run
   * creates, which it links to, and the rows holding a unique value the
   * target holds, which it links to as well. Absent when nothing is.
   */
  leftOut?: {
    writtenBefore: number;
    heldBack: Array<{ objectApiName: string; rows: number }>;
    recordTypeNotInTarget?: Array<{ objectApiName: string; rows: number }>;
    byThePlatform?: Array<{ objectApiName: string; rows: number }>;
    linkedByValue?: Array<{ objectApiName: string; rows: number; fields: readonly string[] }>;
    withoutParent?: Array<{ objectApiName: string; rows: number }>;
    noParentInSource?: Array<{ objectApiName: string; rows: number }>;
    linkedToTarget?: Array<{ objectApiName: string; rows: number }>;
    currencyReplaced?: Array<{ objectApiName: string; rows: number }>;
  };
  /**
   * Set when the rows were counted rather than read: a run of whole tables
   * read page by page asks before it reads anything.
   */
  counted?: true;
  /**
   * Of a clone: of `total`, the contact roles the platform may write itself
   * with their opportunity, for its contact, at most — or may have written
   * with an opportunity the run it takes up wrote (`before`) — which the run
   * links to and does not send: counted in, where the gate could not tell
   * them. Absent when none.
   */
  rolesMayBeByThePlatform?: { rows: number; before?: true };
  /**
   * Of the prices among the rows, those the run may read as it writes them,
   * at most: a price in the currency of the record its lines belong to, the
   * source's own beside the one read. Absent when none.
   */
  pricesForLines?: number;
  /**
   * The daily email limits the records go past as the target's flows send
   * for them, each with the emails sent and what is left; absent when none.
   */
  emails?: Array<{
    limit: 'SingleEmail' | 'DailyWorkflowEmails';
    emails: number;
    remaining: number;
    max: number;
    /** The objects whose inserts send them, with the emails each record sends. */
    objects: Array<{ objectApiName: string; perRecord: number }>;
    /**
     * Set on the single emails of an org that counts its email alerts against
     * them too, as a Developer Edition does: the alerts are among `emails`.
     */
    alertsCounted?: true;
  }>;
  /**
   * Of a run taken up where it stopped, per object, the rows of an insert call
   * under way when it stopped that the target may hold already — records the
   * resume cannot tell from them are there. Written once the user confirms,
   * each may then be there twice. Absent when none.
   */
  mayBeInTarget?: Array<{ objectApiName: string; rows: number }>;
  /**
   * The objects whose rows stop at Records per object with more left in the
   * source, and that cap: the rows past it are not cloned. Absent when none.
   */
  capped?: { perObject: number; objects: string[] };
  /**
   * Of a Sync run: the objects the target takes no record of as the run
   * writes them, not among `objects`, with their records and why. Confirmed,
   * the run leaves them out and writes the rest. Absent when none.
   */
  unwritable?: Array<{
    objectApiName: string;
    rows: number;
    why: 'notInTarget' | 'notCreateable' | 'notUpdateable' | 'unread' | 'notAKey';
    key?: string;
  }>;
  /**
   * Of a Sync run with objects in `unwritable`: the rows of the objects after
   * them it holds back, not among `objects`, a lookup of theirs — `field` —
   * naming a record of `parent` left out, or held back in turn. Confirmed,
   * none of them is written, and each counts as failed. Absent when none.
   */
  heldBack?: Array<{
    objectApiName: string;
    rows: number;
    parent: string;
    field: string;
    /** Each object and lookup that holds rows back, with how many: `rows` in all. */
    parents?: Array<{ parent: string; field: string; rows: number }>;
  }>;
  /**
   * The API requests the run takes, when it would leave the org under a
   * tenth of its daily requests, every part together, and the parts beside
   * the run's own when it has any (`RunRequestParts`: the checkpoint first,
   * the mute's lease, the read-backs, the deliverability read, the fit).
   * Absent otherwise, and
   * from a clone of the whole org, whose own part says them near or not
   * (`WholeOrgConfirmation.targetApi`).
   */
  apiRequests?: {
    estimate: number;
    remaining: number;
    max: number;
    parts?: {
      run: number;
      checkpoint?: number;
      mute?: number;
      readBack?: number;
      deliverability?: number;
      fit?: number;
    };
  };
  /**
   * The checkpoint the run takes of what it writes before its first write,
   * when asked (`Checkpoint first`): what it holds and adds, what it leaves
   * out, what it costs and how long it is kept. Said after what still runs,
   * before the storage. Absent when not asked.
   */
  checkpoint?: RunCheckpointEstimate;
  /**
   * What still runs that may send an email as the records go in, and whether
   * the target delivers them: as {@link AutomationConfirmation.deliverability},
   * for a run whose only question is this one (Sync, Seed, Autopilot).
   */
  deliverability?: RunDeliverability;
  /**
   * The daily email limits the records make the target's flows send against
   * that the target did not say what it has left of. Absent when none.
   */
  emailsUnread?: Array<{
    limit: 'SingleEmail' | 'DailyWorkflowEmails';
    emails: number;
    unread: string;
  }>;
  /**
   * Of a Sync, an Autopilot or a Forge run, why the target's automation — or
   * its flows, processes or workflow rules, or the definition of one — could
   * not be read: the emails they send as the records go in were not counted.
   * Absent when it was read.
   */
  emailsUncounted?: string;
  /**
   * Of a Forge clone, what the last simulation of the same case this window
   * ran counted to write — the same orgs, and the same record, query,
   * template or prompt — beside the rows above: in all, and per object.
   * Absent when there was none.
   */
  simulated?: {
    /** How long before it ended, in minutes, rounded up. */
    minutesBefore: number;
    total: number;
    /** Its rows per object, the most first; an object the simulation wrote none of is absent. */
    objects: Array<{ objectApiName: string; rows: number }>;
    /**
     * Set when `total` is far past what it counted — more than twice, or
     * more than 500 records more: the question is put for it, whatever the
     * volume.
     */
    farAbove?: true;
  };
  /**
   * Of a Forge clone of the whole org (the ALL depth), what else it takes and
   * does besides the rows and their data storage above, as its question says
   * it whatever the volume: it is always asked. Absent for any other run.
   */
  wholeOrg?: WholeOrgConfirmation;
}

/** An allowance of a day an org has, as a clone of the whole org takes of it. */
export interface WholeOrgAllowance {
  /** What the run takes of it, about. */
  estimate: number;
  /** What the org has left of it today, and its most: absent when the org did not say. */
  remaining?: number;
  max?: number;
  /** Set when the run would leave the org less than a tenth of it. */
  near?: true;
  /** Why what is left could not be read, when it could not. */
  unread?: string;
}

/** What a clone of the whole org puts in its question: see {@link WriteConfirmation.wholeOrg}. */
export interface WholeOrgConfirmation {
  /** The org it copies, as the user knows it. */
  source: string;
  /**
   * The objects of the source it leaves out — those discovery left out, each
   * with its reason on Review, and those the user took out there.
   */
  leftOut: number;
  /**
   * What the run was set to that narrows it, carried over from the template
   * or the run it started from or set on Review: the objects read through a
   * filter, those left out by name, those whose rows a decision on Gaps holds
   * back (`skippedRows`), and those with fields left out (`fieldExclusions`),
   * each by name. Absent when nothing does.
   */
  carried?: { filters: string[]; excluded: string[]; heldBack: string[]; fieldsLeftOut: string[] };
  /** The target's API requests, every part together: said whenever it is asked. */
  targetApi: WholeOrgAllowance;
  /** The API requests its reads of the source still take. */
  sourceApi: WholeOrgAllowance;
  /**
   * The API requests its discovery sent each org, as the command line counted
   * them: the objects listed, counted and described before anything else.
   * Absent where nothing counted them.
   */
  discovery?: { source: number; target: number };
  /**
   * The Bulk API 2.0 jobs it sends, the records they carry and the records it
   * sends by REST calls of 200, as its counts say; and the target's daily
   * Bulk API batches the jobs take, as its gate prices them. Absent when it
   * sends no job.
   */
  bulk?: { jobs: number; jobRows: number; restRows: number; batches?: WholeOrgAllowance };
  /** How long its writes take, about, in seconds. */
  durationSeconds: number;
  /** The objects with rows to write that it writes by REST rather than in jobs, by name. */
  restObjects: string[];
  /**
   * The files it copies: how many, what they take, how many are past the
   * largest file copied, and what the target has left of its file storage.
   * Absent when it copies none.
   */
  fileStorage?: {
    files: number;
    estimateMB: number;
    overCeiling: number;
    remainingMB: number;
    maxMB: number;
    /** Set when they take more than 80 % of what the target has left. */
    near?: true;
  };
  /**
   * The objects of managed packages it writes, by name: their package's own
   * triggers and flows run as their records go in, whatever the mute of the
   * target's automation keeps quiet. Absent when it writes none.
   */
  managedPackages?: string[];
  /** The phone numbers it writes empty past the 10 000 its fiction holds, at most. Absent when none. */
  contactPointsBlanked?: number;
  /**
   * Per object it writes, the personal fields it copies as they are — not
   * anonymized. Absent when it copies none so.
   */
  personalAsIs?: Array<{ objectApiName: string; fields: string[] }>;
}

/**
 * What a rehearsal asks once it has prepared the rows, before its first call:
 * how many records it creates in the target and in how many calls, rolled
 * back with each call, and what the target runs as they are created.
 */
export interface RehearsalConfirmation {
  stage: 'rehearsal';
  /** The org the rehearsal creates its records in, as the user knows it. */
  org: string;
  orgTier: SafetyTier;
  /** Records the run would create. */
  rows: number;
  /** Records the rehearsal creates of them: a sample, and the records its rows name. */
  sampled: number;
  /**
   * Updates the rehearsal sends, of those the run makes after its inserts,
   * each of a record it creates, in the call that creates it.
   */
  updates: number;
  /** Composite calls planned, and the most it sends when calls stop at refused records. */
  calls: number;
  maxCalls: number;
  /** What fires on insert, per object, as the run's own question says it. */
  fired: FiredOnInsert[];
  /** What fires on update, per object, on the objects whose records it updates. */
  firedOnUpdate: FiredOnInsert[];
  /** What could not be read of the target's automation, and why. */
  unread: AutomationConfirmation['unread'];
}

/** A question a run puts to the user through the guard's confirmation channel. */
export type RunConfirmation =
  AutomationConfirmation | ReadConfirmation | WriteConfirmation | RehearsalConfirmation;

/** What came of a run's question: answered, or never put, for want of anyone to ask. */
export type RunConfirmationAnswer = 'confirmed' | 'declined' | 'unavailable';

/** Optional runtime configuration for {@link ProductionGuard}. */
export interface ProductionGuardOptions {
  /**
   * UI callback invoked by {@link confirmIfNeeded} when a check result
   * requires explicit user confirmation. Resolves to the user's consent.
   * Wired in extension.ts to a modal `showWarningMessage`; absent in tests
   * (operations proceed, preserving pre-existing behavior).
   *
   * Handed the tier that asked: staging asks too, and the modal told every
   * question that it wrote to a production org. Handed the question in plain
   * words too, when the guard can name the org ({@link orgNameOf}).
   */
  requestConfirmation?: (
    impactSummary: string,
    orgTier: SafetyTier,
    question?: string,
  ) => Promise<boolean>;
  /**
   * The name the user knows an org by — its alias — for the question the
   * confirmation puts (`confirmationQuestionOf`). The impact summary names the
   * org by its id, the operation in capitals, an internal name for a run of
   * several objects and the module in brackets: "INSERT 500 SeedData
   * record(s) on production org 00D… [module: seed]" was the whole question.
   */
  orgNameOf?: (orgId: string) => string | undefined;
  /**
   * The words the question is put in ({@link confirmationQuestionOf}):
   * English by default; the host's translations, keyed on the same English,
   * in VS Code. The modal around it was translated and the question in it was
   * English in every language.
   */
  questionWords?: QuestionWords;
  /**
   * Puts a run's question ({@link RunConfirmation}) to the user: what the
   * target runs as the run inserts, and the source tables it reads with no
   * cap past the ceiling, before it reads; how much it writes and
   * the storage that takes, before it writes. Resolves to the user's consent.
   * Wired in the extension to the same modal as {@link requestConfirmation};
   * absent, there is nobody to ask, and {@link confirmRun} says so.
   */
  requestRunConfirmation?: (question: RunConfirmation) => Promise<boolean>;
  /**
   * Why {@link requestConfirmation} answers no for a tier without asking
   * anyone, when it does: a command line's, for a production org. Undefined
   * for a tier someone would be asked about, or let through. What a preview,
   * which asks nothing, says a run there would be answered
   * ({@link declinedWithoutAsking}).
   */
  declinesWithoutAsking?: (orgTier: SafetyTier) => string | undefined;
}

/**
 * The answer to the guard's confirmation given before the run asked it: a
 * pipeline's Approval step, which a person answered in VS Code before the
 * Sync step after it started. `approved` false stands for nobody having
 * approved — no Approval step before the run, or one rejected or left
 * unanswered — and a question is then declined, never put to a modal nobody
 * watches.
 */
export interface GivenAnswer {
  approved: boolean;
}

/**
 * The answer given for the run under way, by async call chain: the run a
 * pipeline step starts carries it through every await, and a run started
 * elsewhere at the same moment — from the Sync page, by its schedule — does
 * not see it. `live` turns false once that run has ended: a timer or a
 * listener made during it keeps its async context, and a run it starts later,
 * with nobody watching, was not the one approved.
 */
const givenAnswers = new AsyncLocalStorage<GivenAnswer & { live: boolean }>();

/** The answer given for the run under way, while that run lasts. */
export function liveAnswer(): GivenAnswer | undefined {
  const given = givenAnswers.getStore();
  return given?.live ? given : undefined;
}

/**
 * Run `work` with `answer` standing for the confirmation the guard would
 * otherwise ask for. The guard still checks every request: a run it refuses
 * is refused whatever the answer, and a run it lets through without asking
 * never reads it. Only the question is answered, and the decision the write
 * path records is the person's — `confirmed`, or `declined`.
 * @param answer - The answer given before the run
 * @param work - The run
 */
export async function withGivenAnswer<T>(answer: GivenAnswer, work: () => Promise<T>): Promise<T> {
  const given = { approved: answer.approved, live: true };
  try {
    return await givenAnswers.run(given, work);
  } finally {
    given.live = false;
  }
}

/**
 * Guards against dangerous operations on production and staging orgs.
 * Enforces tier-based rules for writes, deletes, and large-volume operations.
 */
export class ProductionGuard {
  private readonly overrides: Map<string, boolean> = new Map();
  private readonly options: ProductionGuardOptions;

  constructor(options?: ProductionGuardOptions) {
    this.options = options ?? {};
  }

  /**
   * Evaluate an operation request against the safety rules for its org tier.
   * Returns whether the operation is allowed, requires confirmation, or is blocked.
   */
  check(request: OperationRequest): SafetyCheckResult {
    const result = this.checkTier(request);
    const { orgNameOf } = this.options;
    if (!result.requiresConfirmation || !orgNameOf) return result;
    return {
      ...result,
      question: confirmationQuestionOf(
        request,
        orgNameOf(request.orgId),
        this.options.questionWords,
      ),
    };
  }

  /** The rules of the request's tier. */
  private checkTier(request: OperationRequest): SafetyCheckResult {
    switch (request.orgTier) {
      case 'production':
        return this.checkProduction(request);
      case 'staging':
        return this.checkStaging(request);
      case 'development':
      case 'scratch':
        return this.checkDevelopment(request);
    }
  }

  /** Allow or disallow a specific org to override production blocks */
  setProductionOverride(orgId: string, allowed: boolean): void {
    this.overrides.set(orgId, allowed);
  }

  /** Check whether a specific org has an active production override */
  isProductionOverridden(orgId: string): boolean {
    return this.overrides.get(orgId) === true;
  }

  /**
   * Whether a confirmation can be put to someone. With no confirmation UI — a
   * unit test, a command-line runner — {@link confirmIfNeeded} lets through a
   * run it would otherwise have asked about, and a record of that run must not
   * say that anyone confirmed it. A run given its answer beforehand
   * ({@link withGivenAnswer}) was answered by a person, whatever UI there is.
   */
  get canAskForConfirmation(): boolean {
    return this.options.requestConfirmation !== undefined || liveAnswer() !== undefined;
  }

  /**
   * Ask the user to confirm an operation whose check result requires
   * confirmation. Returns true when the operation may proceed.
   *
   * When no confirmation UI is wired (unit tests, headless hosts), proceeds
   * and returns true — the pre-existing behavior for every caller.
   *
   * A run given its answer beforehand ({@link withGivenAnswer}) takes that
   * answer, and nothing is shown: a pipeline runs where nobody may be
   * watching, and a modal left open held its Sync step until the run's time
   * ran out — to start writing whenever someone came back and pressed it.
   *
   * @param result - The check of the operation.
   * @param orgTier - The tier of the org it writes to, which the question names.
   */
  async confirmIfNeeded(result: SafetyCheckResult, orgTier: SafetyTier): Promise<boolean> {
    if (!result.allowed || !result.requiresConfirmation) {
      return result.allowed;
    }
    const given = liveAnswer();
    if (given) {
      return given.approved;
    }
    if (!this.options.requestConfirmation) {
      return true;
    }
    return result.question === undefined
      ? this.options.requestConfirmation(result.impactSummary, orgTier)
      : this.options.requestConfirmation(result.impactSummary, orgTier, result.question);
  }

  /**
   * Why the confirmation `result` needs would be answered no without anyone
   * asked — the answer {@link ProductionGuardOptions.declinesWithoutAsking}
   * gives its tier —, or undefined when it needs none, is given its answer
   * beforehand, or would be put to someone. Asks nothing: what a preview says
   * a run would meet.
   */
  declinedWithoutAsking(result: SafetyCheckResult, orgTier: SafetyTier): string | undefined {
    if (!result.allowed || !result.requiresConfirmation || liveAnswer()) return undefined;
    if (!this.options.requestConfirmation) return undefined;
    return this.options.declinesWithoutAsking?.(orgTier);
  }

  /**
   * Put a run's question to the user. Unlike {@link confirmIfNeeded}, a host
   * with nobody to ask does not let the run through: the answer says so, and
   * a run that needed it does not go on without it.
   */
  async confirmRun(question: RunConfirmation): Promise<RunConfirmationAnswer> {
    if (!this.options.requestRunConfirmation) return 'unavailable';
    return (await this.options.requestRunConfirmation(question)) ? 'confirmed' : 'declined';
  }

  /** The org a refusal names: by the alias the user knows it by, else by its id. */
  private orgPhrase(request: OperationRequest, words: QuestionWords): string {
    const name = this.options.orgNameOf?.(request.orgId);
    return name
      ? words.org(request.orgTier, name, true)
      : words.org(request.orgTier, request.orgId, false);
  }

  /** Apply production-tier safety rules */
  private checkProduction(request: OperationRequest): SafetyCheckResult {
    const warnings: string[] = [];
    const isDestructive = DESTRUCTIVE_OPERATIONS.has(request.operation);
    const isOverridden = this.isProductionOverridden(request.orgId);

    warnings.push(
      `Production operation: ${request.operation} on ${request.objectName} ` +
        `(${describeCount(request.recordCount)} ${unitOf(request)}` +
        `${request.alsoWrites ? `, plus ${request.alsoWrites}` : ''})`,
    );

    const words = this.options.questionWords ?? ENGLISH_QUESTION_WORDS;
    if (request.operation === 'deploy') {
      // No override lifts this one. A metadata deployment changes what every
      // user of the org runs, and SandForge offers it to move changes between
      // development orgs; an org of unknown type is here too (orgTypeToGuardTier).
      return {
        allowed: false,
        requiresConfirmation: false,
        blockedReason: words.deployRefused(this.orgPhrase(request, words)),
        warnings,
        impactSummary: buildImpactSummary(request),
      };
    }

    if (isDestructive && !isOverridden) {
      // Said in the user's words, as the deployment's refusal is: it read
      // "hardDelete is not allowed on production org 00D…" inside the
      // translated sentence each module puts it in.
      return {
        allowed: false,
        requiresConfirmation: false,
        blockedReason: words.deleteRefused(
          request.operation === 'hardDelete' ? 'hardDelete' : 'delete',
          this.orgPhrase(request, words),
        ),
        warnings,
        impactSummary: buildImpactSummary(request),
      };
    }

    if (isDestructive && isOverridden) {
      warnings.push('Production override is active — destructive operation permitted');
    }

    // Every write to a production org is asked about, and no setting turns
    // the question off. `sandforge.safety.requireProdConfirmation` did: once
    // false, Seed, Sync, Autopilot and DataOps wrote into production without
    // a word, where their command lines refuse a production target outright
    // and Forge refuses it in the panel too.
    return {
      allowed: true,
      requiresConfirmation: true,
      warnings,
      impactSummary: buildImpactSummary(request),
    };
  }

  /** Apply staging-tier safety rules */
  private checkStaging(request: OperationRequest): SafetyCheckResult {
    const warnings: string[] = [];
    const isDestructive = DESTRUCTIVE_OPERATIONS.has(request.operation);
    const isDeploy = request.operation === 'deploy';
    const requiresConfirmation =
      isDestructive ||
      isDeploy ||
      countForThreshold(request.recordCount) > STAGING_CONFIRMATION_THRESHOLD;

    if (isDestructive) {
      warnings.push(
        `Destructive operation (${request.operation}) on staging org — confirmation required`,
      );
    }
    if (isDeploy) {
      warnings.push('Metadata deployment on staging org — confirmation required');
    }

    if (countForThreshold(request.recordCount) > STAGING_CONFIRMATION_THRESHOLD) {
      warnings.push(
        `Large volume operation: ${describeCount(request.recordCount)} records on staging`,
      );
    }

    return {
      allowed: true,
      requiresConfirmation,
      warnings,
      impactSummary: buildImpactSummary(request),
    };
  }

  /** Apply development/scratch-tier safety rules (permissive) */
  private checkDevelopment(request: OperationRequest): SafetyCheckResult {
    const warnings: string[] = [];

    if (countForThreshold(request.recordCount) > DEV_WARNING_THRESHOLD) {
      warnings.push(
        `Large volume operation: ${describeCount(request.recordCount)} records on ${request.orgTier} org`,
      );
    }

    return {
      allowed: true,
      requiresConfirmation: false,
      warnings,
      impactSummary: buildImpactSummary(request),
    };
  }
}

/**
 * Spell out a record count, say it is the most the operation can write, or
 * say the caller could not count it yet.
 */
function describeCount(recordCount: OperationRequest['recordCount']): string {
  if (recordCount === 'unknown') return 'an unknown number of';
  return typeof recordCount === 'number' ? String(recordCount) : `at most ${recordCount.atMost}`;
}

/**
 * The count to compare against a volume threshold. An uncounted request has
 * nothing to measure, so it stays below every threshold rather than tripping
 * a gate on a volume nobody established. One counted at most is measured at
 * that most: the run may write it.
 */
function countForThreshold(recordCount: OperationRequest['recordCount']): number {
  if (recordCount === 'unknown') return 0;
  return typeof recordCount === 'number' ? recordCount : recordCount.atMost;
}

/** What the operation's count counts: components for a deployment, records otherwise. */
function unitOf(request: OperationRequest): string {
  return request.operation === 'deploy' ? 'components' : 'records';
}

/**
 * What a Forge clone writes besides the records it counts before the run:
 * the catalog, order items and parents its records name.
 */
export const RELATED_RECORDS_ALSO_WRITTEN = 'the related records the run adds';

/**
 * The words a confirmation's question is put in, piece by piece, so a
 * language can order them its own way: the sentence of each operation, how
 * many of what, what it writes besides, and the org. The refusal of a
 * deployment is put in them too, the org named as a question names it.
 */
export interface QuestionWords {
  /** The whole question, `things` and `org` put in the operation's sentence. */
  sentence: (operation: OperationRequest['operation'], things: string, org: string) => string;
  /** How many records, or components for a deployment; none counted, the plural alone. */
  counted: (unit: 'record' | 'component', count: OperationRequest['recordCount']) => string;
  /** The records counted, then what the operation writes besides. */
  besides: (counted: string, alsoWrites: string) => string;
  /** The org, by its tier and its alias — or by its id when nobody named it. */
  org: (tier: SafetyTier, name: string, named: boolean) => string;
  /**
   * Why a deployment to `org` is refused: the orgs SandForge deploys to are
   * those `isDevelopmentOrg` accepts — a sandbox, a scratch org or a
   * Developer Edition org. The refusal said "to sandboxes only" after the
   * last two became development orgs, and in English in every language.
   */
  deployRefused: (org: string) => string;
  /**
   * Why a delete, or a permanent delete, in `org` is refused: a production
   * org takes neither. It named the operation by its code and the org by its
   * id, in English, inside each module's translated sentence.
   */
  deleteRefused: (operation: 'delete' | 'hardDelete', org: string) => string;
}

/** The question in English, as every host without translations asks it. */
export const ENGLISH_QUESTION_WORDS: QuestionWords = {
  sentence: (operation, things, org) => {
    switch (operation) {
      case 'insert':
        return `Insert ${things} into ${org}.`;
      case 'update':
        return `Update ${things} in ${org}.`;
      case 'upsert':
        return `Insert or update ${things} in ${org}.`;
      case 'delete':
        return `Delete ${things} in ${org}.`;
      case 'hardDelete':
        return `Permanently delete ${things} in ${org}.`;
      case 'deploy':
        return `Deploy ${things} to ${org}.`;
    }
  },
  counted: (unit, count) =>
    count === 'unknown'
      ? `${unit}s`
      : typeof count === 'number'
        ? `${count} ${unit}${count === 1 ? '' : 's'}`
        : `at most ${count.atMost} ${unit}s`,
  besides: (counted, alsoWrites) => `${counted}, plus ${alsoWrites},`,
  org: (tier, name, named) => (named ? `the ${tier} org "${name}"` : `the ${tier} org ${name}`),
  deployRefused: (org) =>
    `SandForge deploys metadata only to a sandbox, a scratch org or a Developer Edition org, not to ${org}.`,
  deleteRefused: (operation, org) =>
    operation === 'hardDelete'
      ? `Permanently deleting records is not allowed in ${org}.`
      : `Deleting records is not allowed in ${org}.`,
};

/**
 * The names a run of several objects stands under in a request when it has
 * none to give before it runs: no object of the org, and nothing for the
 * person asked.
 */
const NO_OBJECT_NAMES = new Set(['SeedData', 'SyncData', 'CloneData', 'AutopilotData']);

/**
 * The question a confirmation puts, in plain words: what the operation does,
 * how many records or components, of which objects, in which org — named by
 * its alias, the tier said in words. No module tag, no stand-in object name,
 * no org id but for an org nobody named.
 *
 * @param orgName - The alias the user knows the org by; absent, its id.
 */
export function confirmationQuestionOf(
  request: OperationRequest,
  orgName?: string,
  words: QuestionWords = ENGLISH_QUESTION_WORDS,
): string {
  const unit = request.operation === 'deploy' ? 'component' : 'record';
  const objects = NO_OBJECT_NAMES.has(request.objectName) ? '' : ` (${request.objectName})`;
  const counted = `${words.counted(unit, request.recordCount)}${objects}`;
  const things = request.alsoWrites ? words.besides(counted, request.alsoWrites) : counted;
  const org = orgName
    ? words.org(request.orgTier, orgName, true)
    : words.org(request.orgTier, request.orgId, false);
  return words.sentence(request.operation, things, org);
}

/** Build a human-readable impact summary for an operation */
function buildImpactSummary(request: OperationRequest): string {
  if (request.operation === 'deploy') {
    return (
      `DEPLOY ${describeCount(request.recordCount)} component(s) (${request.objectName}) ` +
      `to ${request.orgTier} org ${request.orgId} [module: ${request.module}]`
    );
  }
  const besides = request.alsoWrites ? `, plus ${request.alsoWrites},` : '';
  return (
    `${request.operation.toUpperCase()} ${describeCount(request.recordCount)} ` +
    `${request.objectName} record(s)${besides} on ${request.orgTier} org ${request.orgId} ` +
    `[module: ${request.module}]`
  );
}

// ─── The checkpoint's block of a run's question ──────────────────────────────

/**
 * The blocks of a run's one question before it writes, in the order it says
 * them: what leaves the org — whether the target delivers the emails what
 * still runs sends, and its daily emails —; the automation that still runs;
 * the checkpoint the run takes first; then the storage, the API requests and
 * the fit. Forge says the first two at its automation question, before it
 * reads its rows, and the last two at its write gate, once they are read.
 */
export const WRITE_QUESTION_BLOCKS = [
  'leavesTheOrg',
  'stillRunning',
  'checkpoint',
  'limits',
] as const;

/** A block of a run's question ({@link WRITE_QUESTION_BLOCKS}). */
export type WriteQuestionBlock = (typeof WRITE_QUESTION_BLOCKS)[number];

/** The lines of a run's question, each block's in its place, whatever order they were made in. */
export function inQuestionOrder(
  blocks: Partial<Record<WriteQuestionBlock, readonly string[]>>,
): string[] {
  return WRITE_QUESTION_BLOCKS.flatMap((block) => [...(blocks[block] ?? [])]);
}

/** What the checkpoint's block says it costs, as its words are handed it. */
export interface CheckpointCost {
  records: number;
  objects: number;
  requests: number;
  seconds: number;
  /** What it keeps on this machine, in MB as the block says them: to a tenth, rounded up. */
  megabytes: string;
  /** The days it is kept; 0 keeps it until it is deleted. */
  keepDays: number;
}

/**
 * The words the checkpoint's block of a run's question is put in, piece by
 * piece ({@link checkpointQuestionLines}): English by default, the host's
 * translations in VS Code. Why an object is added or left out is the
 * engine's sentence, put in as it is.
 */
export interface CheckpointQuestionWords {
  /** What it costs, what it keeps where, and for how long. */
  cost: (cost: CheckpointCost) => string;
  /** An object it holds beside those the run writes, and why. */
  added: (objectApiName: string, reason: string) => string;
  /** An object it does not hold, and what a rewind does to it. */
  notHeld: (objectApiName: string, reason: string) => string;
  /** The objects of a list past those it names. */
  more: (count: number) => string;
  /**
   * What no read tells: the records an Apex trigger, whose code is not read,
   * or automation that could not be read creates as the run writes.
   */
  unknown: string;
}

/** `count` of `unit`, the unit in the plural but for one. */
function counted(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/** The checkpoint's block in English, as every host without translations says it. */
export const ENGLISH_CHECKPOINT_WORDS: CheckpointQuestionWords = {
  cost: ({ records, objects, requests, seconds, megabytes, keepDays }) =>
    `Checkpoint first: about ${counted(records, 'record')} of ${counted(objects, 'object')}, ` +
    `${counted(requests, 'API request')}, ${seconds} s, ${megabytes} MB on this machine, ` +
    "unencrypted, and none of the org's storage, " +
    (keepDays === 0 ? 'kept until you delete it.' : `kept ${counted(keepDays, 'day')}.`),
  added: (objectApiName, reason) => `Added: ${objectApiName} — ${reason}`,
  notHeld: (objectApiName, reason) => `Not in the checkpoint: ${objectApiName} — ${reason}`,
  more: (count) => `… and ${count} more`,
  unknown:
    'What an Apex trigger, or automation that could not be read, creates as the run writes is ' +
    'not known: a rewind leaves those records as they are.',
};

/** The objects a list of the checkpoint's block names before it counts the rest. */
const CHECKPOINT_LISTED = 10;

/** Megabytes as the checkpoint's block says them: to a tenth, rounded up, never 0 of a take that keeps a byte. */
function megabytesOf(bytes: number): string {
  if (bytes <= 0) return '0';
  return Math.max(0.1, Math.ceil((bytes / BYTES_PER_MB) * 10 - 1e-9) / 10).toFixed(1);
}

/**
 * What a run's question says of the checkpoint it takes first, its third
 * block ({@link WRITE_QUESTION_BLOCKS}): what it costs — the target's tables,
 * not the run's rows — what it keeps on this machine and how long; each
 * object it adds beside those the run writes, and why; each it does not
 * hold, and what a rewind does to it; and what no read can tell. A run whose
 * checkpoint is refused is refused before its question, so the block never
 * says a refusal.
 */
export function checkpointQuestionLines(
  checkpoint: Pick<
    RunCheckpointEstimate,
    'estimate' | 'objects' | 'added' | 'notHeld' | 'keepDays'
  >,
  words: CheckpointQuestionWords = ENGLISH_CHECKPOINT_WORDS,
): string[] {
  const { estimate } = checkpoint;
  const lines = [
    words.cost({
      records: estimate.records,
      objects: checkpoint.objects.length,
      requests: estimate.apiRequests,
      seconds: Math.ceil(estimate.seconds),
      megabytes: megabytesOf(estimate.bytes),
      keepDays: checkpoint.keepDays,
    }),
  ];
  const list = (
    notes: RunCheckpointEstimate['added'],
    say: (objectApiName: string, reason: string) => string,
  ): void => {
    for (const { objectApiName, reason } of notes.slice(0, CHECKPOINT_LISTED)) {
      lines.push(say(objectApiName, reason));
    }
    if (notes.length > CHECKPOINT_LISTED) lines.push(words.more(notes.length - CHECKPOINT_LISTED));
  };
  list(checkpoint.added, words.added);
  list(checkpoint.notHeld, words.notHeld);
  lines.push(words.unknown);
  return lines;
}
