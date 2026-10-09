import type { ForgeRemovalRisk } from '@sandforge/shared';

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
}

/**
 * What a run asks before it reads anything, when it reads source tables with
 * no cap per object past the most rows of one object it holds at once: it
 * holds every row it reads of an object until it writes them.
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
  /** The most rows of one object a run reads without asking. */
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
  }>;
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
   * Mirrors the `sandforge.safety.requireProdConfirmation` setting
   * (manifest default true). When off, production-tier writes no longer
   * request an explicit confirmation. Read at call time.
   */
  isProdConfirmationRequired?: () => boolean;
  /**
   * UI callback invoked by {@link confirmIfNeeded} when a check result
   * requires explicit user confirmation. Resolves to the user's consent.
   * Wired in extension.ts to a modal `showWarningMessage`; absent in tests
   * (operations proceed, preserving pre-existing behavior).
   *
   * Handed the tier that asked: staging asks too, and the modal told every
   * question that it wrote to a production org.
   */
  requestConfirmation?: (impactSummary: string, orgTier: SafetyTier) => Promise<boolean>;
  /**
   * Puts a run's question ({@link RunConfirmation}) to the user: what the
   * target runs as the run inserts, and the source tables it reads with no
   * cap past the ceiling, before it reads; how much it writes and
   * the storage that takes, before it writes. Resolves to the user's consent.
   * Wired in the extension to the same modal as {@link requestConfirmation};
   * absent, there is nobody to ask, and {@link confirmRun} says so.
   */
  requestRunConfirmation?: (question: RunConfirmation) => Promise<boolean>;
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
   * say that anyone confirmed it.
   */
  get canAskForConfirmation(): boolean {
    return this.options.requestConfirmation !== undefined;
  }

  /**
   * Ask the user to confirm an operation whose check result requires
   * confirmation. Returns true when the operation may proceed.
   *
   * When no confirmation UI is wired (unit tests, headless hosts), proceeds
   * and returns true — the pre-existing behavior for every caller.
   *
   * @param result - The check of the operation.
   * @param orgTier - The tier of the org it writes to, which the question names.
   */
  async confirmIfNeeded(result: SafetyCheckResult, orgTier: SafetyTier): Promise<boolean> {
    if (!result.allowed || !result.requiresConfirmation) {
      return result.allowed;
    }
    if (!this.options.requestConfirmation) {
      return true;
    }
    return this.options.requestConfirmation(result.impactSummary, orgTier);
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

  /** Whether production operations require an explicit confirmation (setting-backed). */
  private requireProdConfirmation(): boolean {
    return this.options.isProdConfirmationRequired?.() ?? true;
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

    if (request.operation === 'deploy') {
      // No override lifts this one. A metadata deployment changes what every
      // user of the org runs, and SandForge offers it to move changes between
      // sandboxes; an org of unknown type is here too (orgTypeToGuardTier).
      return {
        allowed: false,
        requiresConfirmation: false,
        blockedReason:
          `deploy is not allowed on production org ${request.orgId}: ` +
          'SandForge deploys metadata to sandboxes only',
        warnings,
        impactSummary: buildImpactSummary(request),
      };
    }

    if (isDestructive && !isOverridden) {
      return {
        allowed: false,
        requiresConfirmation: false,
        blockedReason: `${request.operation} is not allowed on production org ${request.orgId}`,
        warnings,
        impactSummary: buildImpactSummary(request),
      };
    }

    if (isDestructive && isOverridden) {
      warnings.push('Production override is active — destructive operation permitted');
    }

    return {
      allowed: true,
      requiresConfirmation: this.requireProdConfirmation(),
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
